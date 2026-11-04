// Loads the AOT image produced by `node aot/cli.ts image` (see aot/src/module.ts) and plugs it into
// the runtime's dispatcher.
//
// The Android build defines RT_PLAYER, so `core.cpp` asks `rt::game_owns`/`rt::game_call` instead of
// using a statically linked recompiled table. Those two functions live here: the image is mapped
// executable, relocated against the C function pointers of the runtime imports, and every guest
// function is then reachable by its guest address.
//
// Image (`game.sk2a`):
//
//   0   u32 magic "SK2A"      8  u32 codeSize    16  u32 relocCount   24  u64 imageBase
//   4   u16 version          12  u32 entryCount  20  u32 tableCount   32  u64 reserved[3]
//  64   u32 entries[entryCount] | u8 code[codeSize]
//       | reloc[relocCount] {u32 at, u32 kind, u64 addend}
//       | table[tableCount] {u32 at, u32 count}
//
// Side table (`game.skx`, written by aot/cli.ts):
//
//   # shrek2 AOT v1
//   # guestAddress codeOffset      (hex, one per line, in image entry order)
//   # traps
//   !message                      (one per line, index = trap id)
//
// Function sizes are not stored in the image, so the offsets have to come from the side table; the
// loader is the only place that knows both file formats and is the counterpart of `relocate()` in
// aot/src/module.ts.
#include <sys/mman.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include "core/rt.h"
#include "platform/platform.h"

extern "C" {
// Declared here rather than in rt.h: `rt_trap_id` is supplied by game_main.cpp and `rt_dispatch_ext`
// by core.cpp, and the web player build declares them at its use site the same way.
void rt_dispatch_ext(Cpu* c, uint32_t target);
void rt_trap_id(Cpu* c, uint32_t id) __attribute__((noreturn));
}

namespace rt {
namespace {

constexpr uint32_t kMagic = 0x41324b53;  // "SK2A"
constexpr uint16_t kVersion = 1;
constexpr size_t kHeaderSize = 64;
constexpr size_t kRelocSize = 16;
constexpr size_t kTableSize = 8;

uint8_t* g_code = nullptr;   // mapped code (RX after loading)
uint32_t g_code_size = 0;
// Guest address -> code. Guest .text is dense but functions can be far apart, so a hash map costs
// less than an address-indexed array.
std::vector<std::pair<uint32_t, uint8_t*>> g_slots;
size_t g_mask = 0;
std::vector<std::string> g_traps;
uint32_t g_functions = 0;

uint32_t hash(uint32_t v) {
  v *= 0x9e3779b1u;
  return v ^ (v >> 15);
}

void insert(uint32_t guest, uint8_t* code) {
  size_t i = hash(guest) & g_mask;
  while (g_slots[i].second) i = (i + 1) & g_mask;
  g_slots[i] = {guest, code};
}

uint8_t* lookup(uint32_t guest) {
  if (g_slots.empty()) return nullptr;
  for (size_t i = hash(guest) & g_mask;; i = (i + 1) & g_mask) {
    if (!g_slots[i].second) return nullptr;
    if (g_slots[i].first == guest) return g_slots[i].second;
  }
}

/**
 * The runtime imports of the generated code, in the order `RUNTIME_IMPORTS` (aot/src/interp.ts) and
 * `rt_trap_id` (below) declare them. The generated code calls them through the platform ABI with the
 * `Cpu*` as the first argument, so this list must stay aligned with the TypeScript one.
 */
void* runtime_imports[] = {
    (void*)&rt_hle,      (void*)&rt_dispatch_ext, (void*)&rt_trap_id, (void*)&rt_cpuid,
    (void*)&rt_rep_movs, (void*)&rt_rep_stos,     (void*)&rt_rcl,     (void*)&rt_rcr,
    (void*)&rt_f80_load, (void*)&rt_f80_store,    (void*)&rt_fist16,  (void*)&rt_fist32,
    (void*)&rt_fist64,   (void*)&rt_frndint,      (void*)&rt_fxam,    (void*)&rt_sin,
    (void*)&rt_cos,      (void*)&rt_tan,          (void*)&rt_atan2,   (void*)&rt_log2,
    (void*)&rt_f2xm1,    (void*)&rt_fscale,       (void*)&rt_fprem,   (void*)&rt_fprem1,
    (void*)&rt_fnsave,   (void*)&rt_fnstenv,      (void*)&rt_frstor,  (void*)&rt_fldenv,
};
constexpr uint32_t kImportCount = sizeof runtime_imports / sizeof runtime_imports[0];

/** Writes the four MOVZ/MOVK words that load a 64-bit address into x16 (aot/src/module.ts, movAbs64). */
void patch_address(uint8_t* at, uint64_t value) {
  for (uint32_t i = 0; i < 4; i++) {
    const uint32_t imm = (uint32_t)((value >> (16 * i)) & 0xffff);
    const uint32_t word = (i == 0 ? 0xd2800000u : 0xf2800000u | (i << 21)) | (imm << 5) | 16u;
    memcpy(at + 4 * i, &word, 4);
  }
}

bool read_file(const std::string& path, std::vector<uint8_t>& out) {
  FILE* f = fopen(path.c_str(), "rb");
  if (!f) return false;
  fseek(f, 0, SEEK_END);
  const long len = ftell(f);
  fseek(f, 0, SEEK_SET);
  if (len <= 0) {
    fclose(f);
    return false;
  }
  out.resize((size_t)len);
  const bool ok = fread(out.data(), 1, (size_t)len, f) == (size_t)len;
  fclose(f);
  return ok;
}

bool parse_side(const std::string& path, std::vector<uint32_t>& entries, std::vector<uint32_t>& offsets) {
  std::vector<uint8_t> text;
  if (!read_file(path, text)) {
    log(Log::Error, "AOT side table: cannot read %s", path.c_str());
    return false;
  }
  auto hex = [](const char*& p, uint32_t& v) {
    char* end = nullptr;
    v = (uint32_t)strtoul(p, &end, 16);
    if (end == p) return false;
    p = end;
    return true;
  };
  bool in_traps = false;
  for (const char* p = (const char*)text.data(); *p;) {
    const char* eol = strchr(p, '\n');
    const char* end = eol ? eol : p + strlen(p);
    if (end > p && *p == '!') {
      g_traps.emplace_back(p + 1, end - p - 1);
    } else if (strncmp(p, "# traps", 7) == 0) {
      in_traps = true;
    } else if (*p != '#' && !in_traps && end > p) {
      const char* q = p;
      uint32_t entry = 0, offset = 0;
      if (hex(q, entry) && *q == ' ' && hex(++q, offset)) {
        entries.push_back(entry);
        offsets.push_back(offset);
      }
    }
    p = eol ? eol + 1 : end;
  }
  return true;
}

}  // namespace

/** Trap messages live in the side table; the generated code only passes the id. */
const char* aot_trap_message(uint32_t id) { return id < g_traps.size() ? g_traps[id].c_str() : nullptr; }

/** Load an image and its side table, map it RX and wire the dispatcher. */
bool aot_load(const std::string& image_path, const std::string& side_path) {
  std::vector<uint8_t> image;
  if (!read_file(image_path, image)) {
    log(Log::Error, "AOT image: cannot read %s", image_path.c_str());
    return false;
  }
  if (image.size() < kHeaderSize) {
    log(Log::Error, "AOT image: truncated");
    return false;
  }
  uint32_t magic = 0, code_size = 0, entry_count = 0, reloc_count = 0, table_count = 0;
  uint16_t version = 0;
  memcpy(&magic, image.data(), 4);
  memcpy(&version, image.data() + 4, 2);
  memcpy(&code_size, image.data() + 8, 4);
  memcpy(&entry_count, image.data() + 12, 4);
  memcpy(&reloc_count, image.data() + 16, 4);
  memcpy(&table_count, image.data() + 20, 4);
  if (magic != kMagic) {
    log(Log::Error, "AOT image: bad magic 0x%08x", magic);
    return false;
  }
  if (version != kVersion) {
    log(Log::Error, "AOT image: version %u, this runtime wants %u (rebuild the image)", version, kVersion);
    return false;
  }
  const size_t code_offset = kHeaderSize + (size_t)entry_count * 4;
  const size_t reloc_offset = code_offset + code_size;
  const size_t table_offset = reloc_offset + (size_t)reloc_count * kRelocSize;
  if (table_offset + (size_t)table_count * kTableSize != image.size()) {
    log(Log::Error, "AOT image: %zu bytes, header describes %zu", image.size(),
        table_offset + (size_t)table_count * kTableSize);
    return false;
  }

  std::vector<uint32_t> entries, offsets;
  if (!parse_side(side_path, entries, offsets)) return false;
  if (entries.size() != entry_count) {
    log(Log::Error, "AOT side table lists %zu functions, the image has %u", entries.size(), entry_count);
    return false;
  }
  for (uint32_t i = 0; i < entry_count; i++) {
    uint32_t stored = 0;
    memcpy(&stored, image.data() + kHeaderSize + (size_t)i * 4, 4);
    if (stored != entries[i] || offsets[i] + 4 > code_size) {
      log(Log::Error, "AOT side table does not match the image at function %u", i);
      return false;
    }
  }

  // Map the code writable (relocations are applied in place) and flip it to RX afterwards: Android 10
  // and later refuse a mapping that is both writable and executable.
  const size_t rounded = (code_size + 4095) / 4096 * 4096;
  void* mem = mmap(nullptr, rounded, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (mem == MAP_FAILED) {
    log(Log::Error, "AOT image: mmap of %zu bytes failed", rounded);
    return false;
  }
  memcpy(mem, image.data() + code_offset, code_size);
  g_code = (uint8_t*)mem;
  g_code_size = code_size;

  // Resolve relocations: imports become C function pointers, guest calls become addresses inside the
  // image, jump-table entries become absolute block addresses.
  for (uint32_t i = 0; i < reloc_count; i++) {
    uint32_t at = 0, kind = 0;
    uint64_t addend = 0;
    memcpy(&at, image.data() + reloc_offset + (size_t)i * kRelocSize, 4);
    memcpy(&kind, image.data() + reloc_offset + (size_t)i * kRelocSize + 4, 4);
    memcpy(&addend, image.data() + reloc_offset + (size_t)i * kRelocSize + 8, 8);
    if (kind == 2) {
      if (at + 8 > code_size) {
        log(Log::Error, "AOT image: jump-table entry outside the code section");
        return false;
      }
      const uint64_t absolute = (uint64_t)(uintptr_t)(g_code + addend);
      memcpy(g_code + at, &absolute, 8);
      continue;
    }
    if (at + 16 > code_size) {
      log(Log::Error, "AOT image: relocation outside the code section");
      return false;
    }
    uint64_t value = 0;
    if (kind == 0) {
      const uint32_t index = (uint32_t)addend;
      if (index >= kImportCount) {
        log(Log::Error, "AOT image: import index %u is not bound", index);
        return false;
      }
      value = (uint64_t)(uintptr_t)runtime_imports[index];
    } else if (kind == 1) {
      const uint32_t target = (uint32_t)addend;
      for (uint32_t k = 0; k < entry_count; k++) {
        if (entries[k] == target) {
          value = (uint64_t)(uintptr_t)(g_code + offsets[k]);
          break;
        }
      }
      if (!value) {
        log(Log::Error, "AOT image: call to 0x%08x, which is not in the image", target);
        return false;
      }
    } else {
      log(Log::Error, "AOT image: bad relocation kind %u", kind);
      return false;
    }
    patch_address(g_code + at, value);
  }

  // Jump tables point into the code section; their bounds are checked so a corrupt image cannot make
  // the generated code jump into arbitrary memory.
  for (uint32_t i = 0; i < table_count; i++) {
    uint32_t at = 0, count = 0;
    memcpy(&at, image.data() + table_offset + (size_t)i * kTableSize, 4);
    memcpy(&count, image.data() + table_offset + (size_t)i * kTableSize + 4, 4);
    if (at + (size_t)count * 8 > code_size) {
      log(Log::Error, "AOT image: jump table outside the code section");
      return false;
    }
  }

  size_t capacity = 16;
  while (capacity < (size_t)entry_count * 2) capacity *= 2;
  g_slots.assign(capacity, {0, nullptr});
  g_mask = capacity - 1;
  for (uint32_t i = 0; i < entry_count; i++) insert(entries[i], g_code + offsets[i]);
  g_functions = entry_count;

  if (mprotect(g_code, rounded, PROT_READ | PROT_EXEC) != 0) {
    log(Log::Error, "AOT image: mprotect(RX) failed");
    return false;
  }
  __builtin___clear_cache((char*)g_code, (char*)g_code + code_size);
  log(Log::Info, "AOT image: %u functions, %u bytes of code, %zu traps", entry_count, code_size, g_traps.size());
  return true;
}

bool game_owns(uint32_t target) { return lookup(target) != nullptr; }

void game_call(Cpu* c, uint32_t target) {
  uint8_t* code = lookup(target);
  if (!code) fatal("dispatch to 0x%08x, which is not in the AOT image", target);
  // A guest function is `void f(Cpu*)` (aot/src/arch-arm64.ts, the "runtime ABI" note).
  ((void (*)(Cpu*))code)(c);
}

uint32_t game_function_count() { return g_functions; }

}  // namespace rt

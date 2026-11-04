/**
 * Module builder and loader for on-device AOT code.
 *
 * The recompiler produces one IR function per guest function; `Arm64FunctionEmitter` turns each of
 * them into position-independent machine code. Anything the generated code needs from outside its
 * own body -- another guest function, a runtime import, a jump table -- is materialised as an
 * absolute address with a four-instruction `movz`/`movk` sequence or an 8-byte table entry. Those
 * are the only places a module refers to addresses, so recording them is enough to make the image
 * relocatable and cacheable: compile once on the phone, then map the file anywhere.
 *
 * Image layout (little endian, all offsets in bytes):
 *
 *     0   u32 magic "SK2A"
 *     4   u16 version
 *     6   u16 reserved
 *     8   u32 codeSize
 *    12   u32 entryCount
 *    16   u32 relocCount
 *    20   u32 tableCount
 *    24   u64 imageBase          address the image was built for (informational)
 *    32   u64 reserved[3]
 *    64   u32 entries[entryCount]        guest addresses, ascending, parallel to the code
 *         u8  code[codeSize]
 *         reloc[relocCount]  { u32 at, u32 kind, u64 addend }
 *         table[tableCount]  { u32 at, u32 count }
 *
 * `at` in both tables is an offset inside the code section. Relocation kinds are 0 = import (the
 * addend is the runtime import index), 1 = function (the addend is the callee's guest address) and
 * 2 = jump table (the addend is the address the entry must hold, relative to the code section).
 */
import { Arm64FunctionEmitter } from "./arch-arm64.ts";
import type { FunctionCode } from "./arch-arm64.ts";
import { RUNTIME_IMPORTS } from "./interp.ts";
import type { IrFunc } from "../../recomp/src/ir.ts";

export const MODULE_MAGIC = 0x41324b53; // "SK2A"
export const MODULE_VERSION = 1;
export const HEADER_SIZE = 64;
const RELOC_SIZE = 16;
const TABLE_SIZE = 8;

export type RelocKind = "import" | "function" | "table";
const KIND_CODE: Record<RelocKind, number> = { import: 0, function: 1, table: 2 };
const KIND_NAME: RelocKind[] = ["import", "function", "table"];

/** One address the loader has to fill in. */
export interface Reloc {
  /** Offset inside the code section (a `movz`/`movk` sequence, or an 8-byte table entry). */
  at: number;
  kind: RelocKind;
  /**
   * "import": runtime import index. "function": guest address of the callee. "table": the value to
   * store relative to the code section (the loader adds the mapping address).
   */
  addend: bigint;
}

/** A run of 8-byte absolute entries that the loader must fill (jump tables). */
export interface TableRange {
  /** Offset of the first entry inside the code section. */
  at: number;
  count: number;
}

export interface BuiltModule {
  bytes: Uint8Array;
  entries: number[];
  functions: number;
  codeSize: number;
  relocs: Reloc[];
  tables: TableRange[];
  /** Guest address -> offset of that function's code inside the code section. */
  offsets: Map<number, number>;
}

export interface BuildOptions {
  /** Address the image is expected to be mapped at; informational, stored in the header. */
  imageBase?: bigint;
  /** Import order; must match what the loader binds. Defaults to the runtime import list. */
  importNames?: readonly string[];
}

/**
 * Concatenate compiled functions into one loadable image.
 *
 * Nothing is resolved here: the image is fully relocatable, and resolution happens in
 * `relocate()` when the module is mapped. Guest functions are appended in ascending address order
 * and aligned to 16 bytes (the AArch64 instruction size and a convenient copy granularity).
 */
export function buildModule(functions: FunctionCode[], opts: BuildOptions = {}): BuiltModule {
  const ordered = [...functions].sort((a, b) => a.entry - b.entry);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].entry === ordered[i - 1].entry) {
      throw new Error(`duplicate function entry 0x${ordered[i].entry.toString(16)}`);
    }
  }

  const offsets = new Map<number, number>();
  let codeSize = 0;
  for (const f of ordered) {
    codeSize = (codeSize + 15) & ~15;
    offsets.set(f.entry, codeSize);
    codeSize += f.code.length;
  }

  const relocs: Reloc[] = [];
  const tables: TableRange[] = [];
  for (const f of ordered) {
    const base = offsets.get(f.entry)!;
    for (const c of f.calls) relocs.push({ at: base + c.at, kind: "function", addend: BigInt(c.target) });
    for (const im of f.imports) relocs.push({ at: base + im.at, kind: "import", addend: BigInt(im.importIndex) });
    for (const t of f.tables) {
      // Table entries name a block of the same function, so the value they must hold is
      // "this function's code + the block's offset" -- relative to the code section.
      relocs.push({ at: base + t.at, kind: "table", addend: BigInt(base + t.target) });
      const last = tables[tables.length - 1];
      if (last && last.at + 8 * last.count === base + t.at) last.count++;
      else tables.push({ at: base + t.at, count: 1 });
    }
  }
  relocs.sort((a, b) => a.at - b.at);

  const entries = ordered.map((f) => f.entry);
  const codeOffset = HEADER_SIZE + entries.length * 4;
  const total = codeOffset + codeSize + relocs.length * RELOC_SIZE + tables.length * TABLE_SIZE;
  const bytes = new Uint8Array(total);
  const dv = new DataView(bytes.buffer);

  dv.setUint32(0, MODULE_MAGIC, true);
  dv.setUint16(4, MODULE_VERSION, true);
  dv.setUint16(6, 0, true);
  dv.setUint32(8, codeSize, true);
  dv.setUint32(12, entries.length, true);
  dv.setUint32(16, relocs.length, true);
  dv.setUint32(20, tables.length, true);
  dv.setBigUint64(24, opts.imageBase ?? 0n, true);

  entries.forEach((e, i) => dv.setUint32(HEADER_SIZE + i * 4, e, true));
  for (const f of ordered) bytes.set(f.code, codeOffset + offsets.get(f.entry)!);

  let at = codeOffset + codeSize;
  for (const r of relocs) {
    dv.setUint32(at, r.at, true);
    dv.setUint32(at + 4, KIND_CODE[r.kind], true);
    dv.setBigUint64(at + 8, r.addend, true);
    at += RELOC_SIZE;
  }
  for (const t of tables) {
    dv.setUint32(at, t.at, true);
    dv.setUint32(at + 4, t.count, true);
    at += TABLE_SIZE;
  }

  return { bytes, entries, functions: ordered.length, codeSize, relocs, tables, offsets };
}

/** A module read back from disk: what the loader needs in order to map it. */
export interface ParsedModule {
  /** The code section (a view into the original buffer). */
  code: Uint8Array;
  entries: number[];
  /**
   * Guest address -> offset of its code inside the code section. This cannot be recovered from the
   * image (function sizes are not stored), so it is empty for a module read back from disk: the
   * loader pairs `parseModule` with the offsets the builder recorded in its cache manifest.
   */
  offsets: Map<number, number>;
  relocs: Reloc[];
  tables: TableRange[];
  imageBase: bigint;
  codeOffset: number;
}

export function parseModule(bytes: Uint8Array): ParsedModule {
  if (bytes.length < HEADER_SIZE) throw new Error("module is truncated");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== MODULE_MAGIC) throw new Error(`bad module magic 0x${magic.toString(16)}`);
  const version = dv.getUint16(4, true);
  if (version !== MODULE_VERSION) throw new Error(`unsupported module version ${version}`);

  const codeSize = dv.getUint32(8, true);
  const entryCount = dv.getUint32(12, true);
  const relocCount = dv.getUint32(16, true);
  const tableCount = dv.getUint32(20, true);
  const imageBase = dv.getBigUint64(24, true);
  const codeOffset = HEADER_SIZE + entryCount * 4;
  const relocOffset = codeOffset + codeSize;
  const tableOffset = relocOffset + relocCount * RELOC_SIZE;
  const end = tableOffset + tableCount * TABLE_SIZE;
  if (end !== bytes.length) throw new Error(`module is ${bytes.length} bytes, header describes ${end}`);

  const entries: number[] = [];
  for (let i = 0; i < entryCount; i++) entries.push(dv.getUint32(HEADER_SIZE + i * 4, true));
  const offsets = new Map<number, number>();
  // Entry offsets are not stored: the code section is a sequence of aligned functions in entry
  // order, so the loader recovers them the same way the builder laid them out.
  const relocs: Reloc[] = [];
  for (let i = 0; i < relocCount; i++) {
    const a = relocOffset + i * RELOC_SIZE;
    const kind = dv.getUint32(a + 4, true);
    if (kind > 2) throw new Error(`bad relocation kind ${kind}`);
    relocs.push({ at: dv.getUint32(a, true), kind: KIND_NAME[kind], addend: dv.getBigUint64(a + 8, true) });
  }
  const tables: TableRange[] = [];
  for (let i = 0; i < tableCount; i++) {
    const a = tableOffset + i * TABLE_SIZE;
    tables.push({ at: dv.getUint32(a, true), count: dv.getUint32(a + 4, true) });
  }
  return {
    code: bytes.subarray(codeOffset, codeOffset + codeSize),
    entries,
    offsets,
    relocs,
    tables,
    imageBase,
    codeOffset,
  };
}

/** What the loader can ask for when resolving a relocation. */
export interface RelocationTargets {
  /** Address the code section is mapped at. */
  loadAddress: bigint;
  /** Address of a runtime import (a C function pointer on the device). */
  importAddress(name: string, index: number): bigint;
  /** Address of a guest function, including functions this module does not contain (thunks). */
  functionAddress(guestAddress: number): bigint;
  /** Import binding order, matching the order the module was built with. */
  importNames?: readonly string[];
}

/** Writes bytes at an offset from the load address; the harness and the device supply this. */
export type PatchWriter = (offset: number, bytes: Uint8Array) => void;

const movAbs64 = (value: bigint): Uint8Array => {
  // The exact shape `Assembler.movAbs64` emits: MOVZ + three MOVKs into x16.
  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) {
    const imm = Number((value >> BigInt(16 * i)) & 0xffffn);
    const word = i === 0 ? 0xd2800000 | (imm << 5) | 16 : 0xf2800000 | (i << 21) | (imm << 5) | 16;
    dv.setUint32(i * 4, word >>> 0, true);
  }
  return out;
};

/**
 * Resolve every relocation of a module that has been copied to `targets.loadAddress`.
 *
 * This is the only place where absolute addresses enter the image, which is why the same code path
 * is used by the device and by the tests: a bug here would misroute every function call and import.
 */
export function relocate(mod: ParsedModule, targets: RelocationTargets, write: PatchWriter): void {
  const names = targets.importNames ?? RUNTIME_IMPORTS;
  for (const r of mod.relocs) {
    if (r.at >= mod.code.length) throw new Error(`relocation outside the code section at ${r.at}`);
    switch (r.kind) {
      case "import": {
        const index = Number(r.addend);
        const name = names[index];
        if (name === undefined) throw new Error(`import index ${index} is not bound`);
        write(r.at, movAbs64(targets.importAddress(name, index)));
        break;
      }
      case "function":
        write(r.at, movAbs64(targets.functionAddress(Number(r.addend))));
        break;
      case "table": {
        const entry = new Uint8Array(8);
        new DataView(entry.buffer).setBigUint64(0, targets.loadAddress + r.addend, true);
        write(r.at, entry);
        break;
      }
      default:
        throw new Error(`bad relocation kind ${(r as Reloc).kind}`);
    }
  }
}

/** Compile a program's IR functions into one loadable module. */
export function compileFunctions(funcs: IrFunc[], opts: BuildOptions = {}): BuiltModule {
  // One trap table for the whole image: the runtime resolves a trap id against the image, and the
  // generated code can only pass the id it was compiled with.
  const shared = { traps: [] as string[] };
  return buildModule(funcs.map((f) => new Arm64FunctionEmitter(f, shared).emit()), opts);
}

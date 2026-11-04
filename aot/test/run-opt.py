#!/usr/bin/env python3
"""Differential runner for the optimiser test (see aot/test/opt.test.mjs).

Same machinery as run-arch.py -- Unicorn executes the compiled function and the result is compared
against the state the reference interpreter reached -- but the corpus is the optimised IR of functions
shaped like lifted x86, so no runtime helper is called and no guest call is expected. The comparison
covers the whole transferred window, not just the data area: a pass that deleted too much would show
up as a changed register or flag immediately.

Usage: run-opt.py cases.json

Each case carries the machine code, the initial memory image (which contains the `Cpu` struct) and
the state the interpreter ended in. Absolute address materialisations (runtime imports, direct guest
calls) and jump tables are patched exactly the way the Android module loader patches them, so this
also exercises the device relocations.

Runtime helpers are not stubbed. The interpreter records, for every helper call, the memory image
before and after the call plus the value it returned; this runner applies that recorded effect when
the compiled code calls the same helper. Stubs would change which branches the compiled code takes
and the comparison would stop being about the code generator.

Usage: run-arch.py cases.json
Environment: STEPS=1 single-steps the code (for debugging a hang).
"""
import json
import struct
import sys

from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm64_const import (UC_ARM64_REG_D0, UC_ARM64_REG_LR, UC_ARM64_REG_PC,
                                 UC_ARM64_REG_SP, UC_ARM64_REG_X0)

CODE = 0x20000000
TABLE = 0x20f00000
IMPORT = 0x21000000
STACK = 0x22000000
MEM_SIZE = 0x100000
# Only this much of the image is transferred and compared (see `WINDOW` in arch.test.mjs).
WINDOW = 0x10000
MAX_STEPS = 300000
DEBUG_STEPS = bool(__import__("os").environ.get("STEPS"))

def is_nan(bits_value):
    exp = (bits_value >> 52) & 0x7FF
    frac = bits_value & 0xFFFFFFFFFFFFF
    return exp == 0x7FF and frac != 0


CPU_FIELDS = {
    "eax": 0, "ecx": 4, "edx": 8, "ebx": 12, "esp": 16, "ebp": 20, "esi": 24, "edi": 28,
    "eflags": 32, "df": 36, "fs_base": 40, "ftop": 44, "fcw": 48, "fsw": 52, "mxcsr": 56,
}

# Address used to emulate one import: IMPORT + 0x10 * index. The runner stops at the first
# instruction there, applies the recorded effect and returns to the caller.
IMPORT_INDEX = {
    "rt_hle": 0, "rt_dispatch": 1, "rt_trap_id": 2, "rt_cpuid": 3, "rt_rep_movs": 4,
    "rt_rep_stos": 5, "rt_rcl": 6, "rt_rcr": 7, "rt_f80_load": 8, "rt_f80_store": 9,
    "rt_fist16": 10, "rt_fist32": 11, "rt_fist64": 12, "rt_frndint": 13, "rt_fxam": 14,
    "rt_sin": 15, "rt_cos": 16, "rt_tan": 17, "rt_atan2": 18, "rt_log2": 19, "rt_f2xm1": 20,
    "rt_fscale": 21, "rt_fprem": 22, "rt_fprem1": 23, "rt_fnsave": 24, "rt_fnstenv": 25,
    "rt_frstor": 26, "rt_fldenv": 27,
}
# Imports whose result is an integer in x0; every other import may return a double in d0.
INT_RESULT = {"rt_fist16", "rt_fist32", "rt_fist64", "rt_fxam", "rt_parity8", "rt_rcl", "rt_rcr"}


def patch_abs(uc, base, at, value):
    """Patch a `movz`/`movk` address materialisation at `base + at` to hold `value`."""
    for i in range(4):
        imm = (value >> (16 * i)) & 0xFFFF
        word = (0xD2800000 | (imm << 5) | 16) if i == 0 else (0xF2800000 | (i << 21) | (imm << 5) | 16)
        uc.mem_write(base + at + 4 * i, struct.pack("<I", word))


class ImportMismatch(Exception):
    """Raised inside the code hook: Unicorn turns hook exceptions into a stop, but the run-arch
    caller inspects `replayer.errors` afterwards."""


class ImportReplayer:
    """Serves recorded helper calls to the compiled code, in the order the interpreter made them."""

    def __init__(self, uc, events, name):
        self.uc = uc
        self.events = events
        self.next = 0
        self.name = name
        self.errors = []

    def restart(self):
        self.next = 0

    def pending(self):
        return self.events[self.next] if self.next < len(self.events) else None

    def call(self, address):
        index = (address - IMPORT) >> 4
        event = self.pending()
        if event is None:
            self.errors.append("compiled code called a helper the reference never called")
            self.uc.emu_stop()
            return
        if IMPORT_INDEX[event["name"]] != index:
            self.errors.append(f"helper order differs: compiled {event['name']} at index {index}")
            self.uc.emu_stop()
            return
        for offset, hex_bytes in event["writes"]:
            self.uc.mem_write(offset, bytes.fromhex(hex_bytes))
        result = event["result"]
        if result is not None:
            if event["name"] in INT_RESULT:
                self.uc.reg_write(UC_ARM64_REG_X0, int(result) & 0xFFFFFFFFFFFFFFFF)
            else:
                self.uc.reg_write(UC_ARM64_REG_D0, int(event["resultBits"]) & 0xFFFFFFFFFFFFFFFF)
        self.next += 1


def main(path):
    spec = json.load(open(path))
    failures = []
    checked = 0
    for case in spec:
        uc = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
        uc.mem_map(0, MEM_SIZE)
        uc.mem_write(0, bytes.fromhex(case["mem"]))
        uc.mem_map(CODE, 0x10000)
        uc.mem_map(TABLE, 0x10000)
        uc.mem_map(IMPORT, 0x1000)
        uc.mem_map(STACK, 0x20000)
        code = bytes.fromhex(case["code"])
        uc.mem_write(CODE, code)
        # Every import address holds a plain `ret`: the hook applies the recorded effect and the
        # instruction itself returns to the caller, so emulation never has to restart.
        uc.mem_write(IMPORT, b"\xc0\x03\x5f\xd6" * (0x1000 // 4))
        uc.reg_write(UC_ARM64_REG_SP, STACK + 0x8000)
        uc.reg_write(UC_ARM64_REG_X0, case["cpu"])
        # `ret` at the end of the function returns through the link register: point it at the end of
        # the code so the run finishes there instead of jumping to address 0.
        uc.reg_write(UC_ARM64_REG_LR, CODE + len(code))

        replayer = ImportReplayer(uc, case["events"], case["name"])
        for call in case["calls"]:
            patch_abs(uc, CODE, call["at"], TABLE + call["target"])
        for imp in case["imports"]:
            patch_abs(uc, CODE, imp["at"], IMPORT + 0x10 * imp["importIndex"])
        # Jump tables live inside the function, at the offset the assembler reported; the loader
        # fills each entry with the absolute address of the case it names.
        for table in case["tables"]:
            uc.mem_write(CODE + table["at"], struct.pack("<Q", CODE + table["target"]))

        # Only the import range is hooked: a code hook over every instruction would run in Python
        # and dominate the test runtime. The step budget is enforced by Unicorn itself.
        uc.hook_add(UC_HOOK_CODE, lambda u, a, s, _: replayer.call(a), begin=IMPORT, end=IMPORT + 0xFFF)

        try:
            uc.emu_start(CODE, CODE + len(code), 0, 1 if DEBUG_STEPS else MAX_STEPS)
        except Exception as err:  # noqa: BLE001 - reported per case
            pc = uc.reg_read(UC_ARM64_REG_PC)
            failures.append(f"{case['name']}: emulation error {err} at pc=0x{pc:x}")
            continue
        if replayer.errors:
            failures.extend(f"{case['name']}: {e}" for e in replayer.errors)
            continue
        if replayer.next:
            failures.append(f"{case['name']}: the optimiser introduced a runtime call")
            continue
        if uc.reg_read(UC_ARM64_REG_PC) != CODE + len(code):
            failures.append(f"{case['name']}: did not reach the end of the function "
                            f"(pc=0x{uc.reg_read(UC_ARM64_REG_PC):x})")
            continue
        ref = bytes.fromhex(case["refMem"])
        got = bytes(uc.mem_read(0, len(ref)))
        checked += 1
        cpu = case["cpu"]
        # The whole window first: registers, flags and spacer bytes alike. Nothing in this corpus is
        # allowed to differ, so a mismatch anywhere is a real difference.
        for off in range(len(ref)):
            if ref[off] != got[off]:
                failures.append(f"{case['name']}: mem[0x{off:x}] = {got[off]:02x}, want {ref[off]:02x}")
                break
        for name, off in CPU_FIELDS.items():
            a = cpu + off
            if ref[a:a + 4] != got[a:a + 4]:
                failures.append(
                    f"{case['name']}: cpu.{name} = 0x{int.from_bytes(got[a:a+4], 'little'):08x}, "
                    f"want 0x{int.from_bytes(ref[a:a+4], 'little'):08x}")
        for k in range(8):
            a = cpu + 64 + 8 * k
            # NaN sign and payload are not architecturally defined: JavaScript produces the quiet
            # NaN of the engine, AArch64 propagates operand payloads. Only NaN-ness is compared.
            want = int.from_bytes(ref[a:a + 8], "little")
            have = int.from_bytes(got[a:a + 8], "little")
            if want != have and not (is_nan(want) and is_nan(have)):
                failures.append(
                    f"{case['name']}: cpu.fpr[{k}] = {int.from_bytes(got[a:a+8], 'little'):016x}, "
                    f"want {int.from_bytes(ref[a:a+8], 'little'):016x}")

    if failures:
        print(f"FAILURES ({len(failures)}):")
        for f in failures[:40]:
            print("  " + f)
        sys.exit(1)
    print(f"ok: {checked} optimised functions match the reference interpreter")


if __name__ == "__main__":
    main(sys.argv[1])

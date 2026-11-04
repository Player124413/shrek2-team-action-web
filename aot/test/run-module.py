#!/usr/bin/env python3
"""Loads a compiled module the way the Android loader does, then runs it in Unicorn.

This test is about the *loader*, not the code generator (that is `arch.test.mjs`): the image is
parsed from its header, mapped at an address it was not built for, relocated, and executed. Guest to
guest calls go through the relocated `movz`/`movk` sequences, runtime imports land on distinct
addresses, and jump tables hold absolute addresses. A relocation that resolves to the wrong place
shows up as a wrong result or as a run that does not finish.

Usage: run-module.py cases.json
"""
import json
import struct
import sys

from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_ARM, UC_HOOK_CODE
from unicorn.arm64_const import (UC_ARM64_REG_D0, UC_ARM64_REG_LR, UC_ARM64_REG_PC,
                                 UC_ARM64_REG_SP, UC_ARM64_REG_X0)

MEM_SIZE = 0x100000
STACK = 0x23000000
RETURN_SENTINEL = 0x22FFF000
MAX_STEPS = 300000

CPU_FIELDS = {
    "eax": 0, "ecx": 4, "edx": 8, "ebx": 12, "esp": 16, "ebp": 20, "esi": 24, "edi": 28,
    "eflags": 32, "df": 36, "fs_base": 40, "ftop": 44, "fcw": 48, "fsw": 52, "mxcsr": 56,
}

INT_RESULT = {"rt_fist16", "rt_fist32", "rt_fist64", "rt_fxam", "rt_rcl", "rt_rcr"}
RELOC_IMPORT, RELOC_FUNCTION, RELOC_TABLE = 0, 1, 2


def parse_address(text):
    return int(text, 16)


def is_nan(bits_value):
    return (bits_value >> 52) & 0x7FF == 0x7FF and bits_value & 0xFFFFFFFFFFFFF != 0


def mov_abs64(value):
    """The four instruction words of `Assembler.movAbs64` (MOVZ x16 + three MOVKs)."""
    words = []
    for i in range(4):
        imm = (value >> (16 * i)) & 0xFFFF
        words.append(struct.unpack("<I", struct.pack("<I", (0xD2800000 | (imm << 5) | 16) if i == 0
                                                     else (0xF2800000 | (i << 21) | (imm << 5) | 16)))[0])
    return words


class Loader:
    """Minimal implementation of the on-device loader, driven by the module's own header."""

    def __init__(self, image, offsets, load_address, import_address, thunk_address):
        self.load_address = load_address
        self.import_address = import_address
        self.thunk_address = thunk_address
        self.offsets = offsets
        magic, version, _flags, self.code_size, entry_count, reloc_count, table_count = struct.unpack_from(
            "<IHHIIII", image, 0)
        if magic != 0x41324B53:
            raise ValueError("bad module magic")
        if version != 1:
            raise ValueError(f"unsupported module version {version}")
        self.entries = list(struct.unpack_from(f"<{entry_count}I", image, 64))
        self.code_offset = 64 + entry_count * 4
        reloc_offset = self.code_offset + self.code_size
        table_offset = reloc_offset + reloc_count * 16
        if table_offset + table_count * 8 != len(image):
            raise ValueError("module size does not match its header")
        self.code = bytearray(image[self.code_offset:self.code_offset + self.code_size])
        self.relocs = [struct.unpack_from("<IIQ", image, reloc_offset + i * 16) for i in range(reloc_count)]
        self.tables = [struct.unpack_from("<II", image, table_offset + i * 8) for i in range(table_count)]

    def address_of(self, guest_address):
        """Address of a guest function: in this image, or a thunk outside it."""
        offset = self.offsets.get(guest_address)
        return self.thunk_address if offset is None else self.load_address + offset

    def relocate(self):
        """Fill in every absolute address the generated code refers to."""
        for at, kind, addend in self.relocs:
            if kind == RELOC_IMPORT:
                value = self.import_address + 0x10 * addend
            elif kind == RELOC_FUNCTION:
                value = self.address_of(addend)
            elif kind == RELOC_TABLE:
                # Jump-table entries hold the absolute address of the case they name.
                struct.pack_into("<Q", self.code, at, self.load_address + addend)
                continue
            else:
                raise ValueError(f"bad relocation kind {kind}")
            for j, word in enumerate(mov_abs64(value)):
                struct.pack_into("<I", self.code, at + 4 * j, word)


class ImportReplayer:
    """Serves recorded helper calls, in the order the reference interpreter made them."""

    def __init__(self, uc, events):
        self.uc = uc
        self.events = events
        self.next = 0
        self.errors = []

    def call(self, _address):
        if self.next >= len(self.events):
            self.errors.append("compiled code called more runtime imports than the reference")
            return
        event = self.events[self.next]
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
    offsets = {int(k): v for k, v in spec["offsets"].items()}
    # The test writes bare hexadecimal digits; accepting a "0x" prefix as well keeps both forms
    # working, and a wrong base here would simply send the image to an unusable address.
    code_address = parse_address(spec["codeAddress"])
    import_address = parse_address(spec["importAddress"])
    thunk_address = parse_address(spec["thunkAddress"])
    failures = []
    checked = 0

    for case in spec["cases"]:
        try:
            loader = Loader(bytes.fromhex(case["image"]), offsets, code_address, import_address,
                            thunk_address)
            loader.relocate()
        except ValueError as err:
            failures.append(f"{case['index']}: loader error {err}")
            continue

        uc = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
        uc.mem_map(0, MEM_SIZE)
        uc.mem_write(0, bytes.fromhex(case["mem"]))
        # Unicorn wants a non-zero page-multiple; a module can be small, so keep one page minimum.
        image_bytes = max((loader.code_size + 0xFFF) & ~0xFFF, 0x1000)
        uc.mem_map(code_address, image_bytes)
        uc.mem_write(code_address, bytes(loader.code))
        uc.mem_map(import_address, 0x1000)
        uc.mem_write(import_address, b"\xc0\x03\x5f\xd6" * (0x1000 // 4))
        uc.mem_map(thunk_address, 0x1000)
        uc.mem_map(RETURN_SENTINEL & ~0xFFF, 0x1000)
        uc.mem_map(STACK, 0x20000)
        uc.reg_write(UC_ARM64_REG_SP, STACK + 0x8000)
        uc.reg_write(UC_ARM64_REG_X0, case["cpu"])
        uc.reg_write(UC_ARM64_REG_LR, RETURN_SENTINEL)

        replayer = ImportReplayer(uc, case["events"])
        uc.hook_add(UC_HOOK_CODE, lambda u, a, s, _: replayer.call(a), begin=import_address,
                    end=import_address + 0xFFF)
        try:
            uc.emu_start(loader.address_of(0x401000), RETURN_SENTINEL, 0, MAX_STEPS)
        except Exception as err:  # noqa: BLE001 - reported per case
            pc = uc.reg_read(UC_ARM64_REG_PC)
            failures.append(f"{case['index']}: emulation error {err} at pc=0x{pc:x}")
            continue
        if replayer.errors:
            failures.extend(f"{case['index']}: {e}" for e in replayer.errors)
            continue

        ref = bytes.fromhex(case["refMem"])
        got = bytes(uc.mem_read(0, len(ref)))
        checked += 1
        cpu = case["cpu"]
        for name, off in CPU_FIELDS.items():
            a = cpu + off
            if ref[a:a + 4] != got[a:a + 4]:
                failures.append(
                    f"{case['index']}: cpu.{name} = 0x{int.from_bytes(got[a:a+4], 'little'):08x}, "
                    f"want 0x{int.from_bytes(ref[a:a+4], 'little'):08x}")
        for k in range(8):
            a = cpu + 64 + 8 * k
            want = int.from_bytes(ref[a:a + 8], "little")
            have = int.from_bytes(got[a:a + 8], "little")
            if want != have and not (is_nan(want) and is_nan(have)):
                failures.append(f"{case['index']}: cpu.fpr[{k}] = {have:016x}, want {want:016x}")
        for off in range(0x3000, 0x7000):
            if ref[off] != got[off]:
                failures.append(f"{case['index']}: mem[0x{off:x}] = {got[off]:02x}, want {ref[off]:02x}")
                break

    if failures:
        print(f"FAILURES ({len(failures)}):")
        for f in failures[:40]:
            print("  " + f)
        sys.exit(1)
    print(f"ok: {checked} module runs match the reference interpreter")


if __name__ == "__main__":
    main(sys.argv[1])

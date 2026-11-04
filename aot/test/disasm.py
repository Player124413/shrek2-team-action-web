#!/usr/bin/env python3
"""Prints a Capstone disassembly of hex machine code (cross-checks the encoder's intent)."""
import sys
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM
code = bytes.fromhex(sys.argv[1])
base = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0x100000
md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
for i in md.disasm(code, base):
    print(f"{i.address:08x}: {i.bytes.hex():<8} {i.mnemonic} {i.op_str}")

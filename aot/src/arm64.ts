/**
 * AArch64 instruction encoder + single-pass assembler.
 *
 * The Android port compiles the game's translated IR straight to ARM64 machine code on the device
 * (aot/src/arch-arm64.ts). This file therefore covers exactly the subset the code generator needs:
 * integer ALU/shift/multiply/divide, loads and stores with scaled, unscaled and register offsets,
 * pairs, conditional selects and branches, calls through a register, and the scalar
 * floating-point arithmetic/conversions used to lower x87 and SSE.
 *
 * Encodings follow the Arm(R) Architecture Reference Manual (DDI 0487). Every instruction the
 * generator emits is executed by the differential tests (aot/test), which run the assembled bytes
 * in Unicorn and compare against the same semantics the WebAssembly backend implements.
 */

export const SP = 31;
export const XZR = 31;
export const LR = 30;
export const FP = 29;

export const reg = (n: number) => n & 31;

export const Cond = {
  EQ: 0, NE: 1, CS: 2, CC: 3, MI: 4, PL: 5, VS: 6, VC: 7,
  HI: 8, LS: 9, GE: 10, LT: 11, GT: 12, LE: 13, AL: 14,
} as const;

const NEGATED = [Cond.NE, Cond.EQ, Cond.CC, Cond.CS, Cond.PL, Cond.MI, Cond.VC, Cond.VS,
  Cond.LS, Cond.HI, Cond.LT, Cond.GE, Cond.LE, Cond.GT, Cond.AL, Cond.AL];

/** The condition true exactly when `c` is false. */
export const notCond = (c: number) => NEGATED[c & 15];

export type ShiftOp = "lsl" | "lsr" | "asr" | "ror";
const SHIFT_BITS: Record<ShiftOp, number> = { lsl: 0, lsr: 1, asr: 2, ror: 3 };

/** FP rounding decode for FCMP results: EQ means equal, MI means less-than. */
export const FCOND = { LT: Cond.MI, LE: Cond.LS, EQ: Cond.EQ, NE: Cond.NE, GT: Cond.GT, GE: Cond.GE, MI: Cond.MI, LS: Cond.LS } as const;

export interface Fixup {
  at: number;
  label: string;
  kind: "b" | "bcond" | "lit" | "adr";
  patchShift: number;
  patchMask: number;
}

export class Assembler {
  private buf = new Uint8Array(1 << 16);
  private dv = new DataView(this.buf.buffer);
  len = 0;
  private fixups: Fixup[] = [];
  private labels = new Map<string, number>();
  private seq = 0;

  private ensure(n: number): number {
    if (this.len + n > this.buf.length) {
      let cap = this.buf.length * 2;
      while (cap < this.len + n) cap *= 2;
      const b = new Uint8Array(cap);
      b.set(this.buf.subarray(0, this.len));
      this.buf = b;
      this.dv = new DataView(b.buffer);
    }
    const at = this.len;
    this.len += n;
    return at;
  }

  word(w: number): this {
    this.dv.setUint32(this.ensure(4), w >>> 0, true);
    return this;
  }

  bytes(b: ArrayLike<number>): this {
    const at = this.ensure(b.length);
    this.buf.set(b as Uint8Array, at);
    return this;
  }

  align(n: number): this {
    while (this.len % n) this.nop();
    return this;
  }

  bind(label: string): this {
    if (this.labels.has(label)) throw new Error(`label ${label} bound twice`);
    this.labels.set(label, this.len);
    return this;
  }

  fresh(prefix = "L"): string {
    return `${prefix}${this.seq++}`;
  }

  labelOffset(label: string): number | undefined {
    return this.labels.get(label);
  }

  /** Copy a finished sub-assembly in at the current offset, shifting its local offsets. */
  get offset(): number {
    return this.len;
  }

  /** Patch all fixups and return the machine code. */
  finish(): Uint8Array {
    for (const f of this.fixups) {
      const target = this.labels.get(f.label);
      if (target === undefined) throw new Error(`unresolved label ${f.label}`);
      const disp = target - f.at;
      const w = this.dv.getUint32(f.at, true);
      if (f.kind === "adr") {
        if (disp < -(1 << 20) || disp >= 1 << 20) throw new Error(`adr out of range: ${disp}`);
        const lo = disp & 3;
        const hi = (disp >> 2) & 0x7ffff;
        this.dv.setUint32(f.at, ((w & ~((0x7ffff << 5) | (3 << 29))) | (hi << 5) | (lo << 29)) >>> 0, true);
        continue;
      }
      if (f.kind === "lit") {
        // LDR (literal): signed 19-bit offset of words.
        if (disp % 4) throw new Error("unaligned literal load");
        const off = disp >> 2;
        if (off < -(1 << 18) || off >= 1 << 18) throw new Error("literal load out of range");
        this.dv.setUint32(f.at, ((w & ~(f.patchMask << f.patchShift)) | ((off & f.patchMask) << f.patchShift)) >>> 0, true);
        continue;
      }
      if (disp % 4) throw new Error(`unaligned branch target ${f.label}`);
      const off = disp >> 2;
      const limit = f.kind === "b" ? 1 << 25 : 1 << 18;
      if (off < -limit || off >= limit) throw new Error(`branch to ${f.label} out of range (${disp} bytes)`);
      this.dv.setUint32(f.at, ((w & ~(f.patchMask << f.patchShift)) | ((off & f.patchMask) << f.patchShift)) >>> 0, true);
    }
    return this.buf.slice(0, this.len);
  }

  // ---- Branches ---------------------------------------------------------------------------------

  b(label: string): this {
    const at = this.ensure(4);
    this.dv.setUint32(at, 0x14000000, true);
    this.fixups.push({ at, label, kind: "b", patchShift: 0, patchMask: 0x3ffffff });
    return this;
  }

  /** `b` to an absolute offset already known (used for intra-function jumps). */
  bOffset(bytes: number): this {
    if (bytes % 4) throw new Error("unaligned branch");
    const off = bytes >> 2;
    if (off < -(1 << 25) || off >= 1 << 25) throw new Error("b out of range");
    return this.word(0x14000000 | (off & 0x3ffffff));
  }

  bcond(cond: number, label: string): this {
    const at = this.ensure(4);
    this.dv.setUint32(at, (0x54000000 | (cond & 15)) >>> 0, true);
    this.fixups.push({ at, label, kind: "bcond", patchShift: 5, patchMask: 0x7ffff });
    return this;
  }

  cbz(rt: number, label: string, sf = true): this {
    return this.cbzN(false, rt, label, sf);
  }

  cbnz(rt: number, label: string, sf = true): this {
    return this.cbzN(true, rt, label, sf);
  }

  private cbzN(nz: boolean, rt: number, label: string, sf: boolean): this {
    const at = this.ensure(4);
    // SF (bit 31) selects 64-bit; CBZ is 0x34000000 and CBNZ adds bit 24. Rt lives in bits 0-4.
    const base = 0x34000000 | (sf ? 0x80000000 : 0);
    this.dv.setUint32(at, (base | (nz ? 0x01000000 : 0) | (sf ? 0x80000000 : 0) | reg(rt)) >>> 0, true);
    this.fixups.push({ at, label, kind: "bcond", patchShift: 5, patchMask: 0x7ffff });
    return this;
  }

  /** BL to a label (patched at assembly end). */
  bl(label: string): this {
    const at = this.ensure(4);
    this.dv.setUint32(at, 0x94000000, true);
    this.fixups.push({ at, label, kind: "b", patchShift: 0, patchMask: 0x3ffffff });
    return this;
  }

  /** BL to a known relative offset. */
  blOffset(bytes: number): this {
    if (bytes % 4) throw new Error("unaligned bl");
    const off = bytes >> 2;
    if (off < -(1 << 25) || off >= 1 << 25) throw new Error("bl out of range");
    return this.word(0x94000000 | (off & 0x3ffffff));
  }

  blr(rn: number): this { return this.word(0xd63f0000 | (reg(rn) << 5)); }
  br(rn: number): this { return this.word(0xd61f0000 | (reg(rn) << 5)); }
  ret(rn = LR): this { return this.word(0xd65f0000 | (reg(rn) << 5)); }
  nop(): this { return this.word(0xd503201f); }

  // ---- Moves and constants ----------------------------------------------------------------------

  /** MOVZ/MOVN/MOVK chain for any 64-bit constant. */
  movConst(rd: number, value: bigint | number): this {
    const v = BigInt.asUintN(64, typeof value === "number" ? BigInt(value) : value);
    if (v === 0n) return this.word(0xd2800000 | reg(rd));
    const hw = [0, 1, 2, 3].map((i) => Number((v >> BigInt(16 * i)) & 0xffffn));
    const inv = hw.map((h) => (~h) & 0xffff);
    const zeros = hw.filter((h) => h === 0).length;
    const invZeros = inv.filter((h) => h === 0).length;
    if (invZeros === 4) return this.word(0x92800000 | reg(rd)); // MOVN Xd, #0 -> all ones
    if (invZeros > zeros) {
      const first = inv.findIndex((h) => h !== 0);
      this.word(0x92800000 | (first << 21) | (inv[first] << 5) | reg(rd));
      for (let i = 0; i < 4; i++) if (i !== first && inv[i] !== 0) this.word(0xf2800000 | (i << 21) | (inv[i] << 5) | reg(rd));
      return this;
    }
    const first = hw.findIndex((h) => h !== 0);
    this.word(0xd2800000 | (first << 21) | (hw[first] << 5) | reg(rd));
    for (let i = 0; i < 4; i++) if (i !== first && hw[i] !== 0) this.word(0xf2800000 | (i << 21) | (hw[i] << 5) | reg(rd));
    return this;
  }

  /** MOVZ of a 32-bit constant (zero-extended); 1-2 instructions. */
  movConst32(rd: number, value: number): this {
    const v = value >>> 0;
    this.word(0x52800000 | ((v & 0xffff) << 5) | reg(rd));
    if (v >>> 16) this.word(0x72a00000 | ((v >>> 16) << 5) | reg(rd));
    return this;
  }

  mov(rd: number, rm: number, sf = true): this {
    return this.word((sf ? 0xaa0003e0 : 0x2a0003e0) | (reg(rm) << 16) | reg(rd));
  }

  mvn(rd: number, rm: number, sf = true): this {
    return this.word((sf ? 0xaa2003e0 : 0x2a2003e0) | (reg(rm) << 16) | reg(rd));
  }

  /** 32-bit form of `mov` that guarantees the upper 32 bits are zero. */
  movw(rd: number, rm: number): this {
    return this.word(0x2a0003e0 | (reg(rm) << 16) | reg(rd));
  }

  // ---- Arithmetic ------------------------------------------------------------------------------

  addSubImm(kind: "add" | "sub", rd: number, rn: number, imm: number, sf = true, setFlags = false): this {
    if (imm < 0 || imm > 0xfff) throw new Error(`add/sub immediate out of range: ${imm}`);
    return this.word((sf ? 0x91000000 : 0x11000000) | (kind === "sub" ? 0x40000000 : 0) | (setFlags ? 0x20000000 : 0) |
      (imm << 10) | (reg(rn) << 5) | reg(rd));
  }

  /** ADD/SUB immediate with a 12-bit LSL #12 shift. */
  addSubImmShifted(kind: "add" | "sub", rd: number, rn: number, imm: number, shift12: boolean, sf = true, setFlags = false): this {
    if (imm < 0 || imm > 0xfff) throw new Error(`add/sub immediate out of range: ${imm}`);
    return this.word((sf ? 0x91000000 : 0x11000000) | (kind === "sub" ? 0x40000000 : 0) | (setFlags ? 0x20000000 : 0) |
      (shift12 ? 0x400000 : 0) | (imm << 10) | (reg(rn) << 5) | reg(rd));
  }

  addSubReg(kind: "add" | "sub", rd: number, rn: number, rm: number, shift: ShiftOp = "lsl", amount = 0, sf = true, setFlags = false): this {
    return this.word((sf ? 0x8b000000 : 0x0b000000) | (kind === "sub" ? 0x40000000 : 0) | (setFlags ? 0x20000000 : 0) |
      (SHIFT_BITS[shift] << 22) | (reg(rm) << 16) | (amount << 10) | (reg(rn) << 5) | reg(rd));
  }

  add(rd: number, rn: number, rm: number, sf = true): this { return this.addSubReg("add", rd, rn, rm, "lsl", 0, sf); }
  sub(rd: number, rn: number, rm: number, sf = true): this { return this.addSubReg("sub", rd, rn, rm, "lsl", 0, sf); }

  /** ADD (extended register), e.g. `add x0, sp, x1` or `add x0, x1, w2, uxtw`. */
  addExtended(rd: number, rn: number, rm: number, option = 6, sf = true, amount = 0): this {
    return this.word((sf ? 0x8b200000 : 0x0b200000) | (reg(rm) << 16) | (option << 13) | (amount << 10) | (reg(rn) << 5) | reg(rd));
  }

  /** SUB (extended register), e.g. `sub sp, sp, x0`. */
  subExtended(rd: number, rn: number, rm: number, option = 6, sf = true, amount = 0): this {
    return this.word((sf ? 0xcb200000 : 0x4b200000) | (reg(rm) << 16) | (option << 13) | (amount << 10) | (reg(rn) << 5) | reg(rd));
  }

  cmpReg(rn: number, rm: number, shift: ShiftOp = "lsl", amount = 0, sf = true): this {
    return this.addSubReg("sub", XZR, rn, rm, shift, amount, sf, true);
  }

  cmpImm(rn: number, imm: number, sf = true): this { return this.addSubImm("sub", XZR, rn, imm, sf, true); }
  cmnImm(rn: number, imm: number, sf = true): this { return this.addSubImm("add", XZR, rn, imm, sf, true); }

  private logical(kind: number, rd: number, rn: number, rm: number, shift: ShiftOp, amount: number, sf: boolean, invert: boolean): this {
    return this.word((sf ? 0x8a000000 : 0x0a000000) | (kind << 29) | (SHIFT_BITS[shift] << 22) | (invert ? 0x200000 : 0) |
      (reg(rm) << 16) | (amount << 10) | (reg(rn) << 5) | reg(rd));
  }

  and(rd: number, rn: number, rm: number, shift: ShiftOp = "lsl", amount = 0, sf = true): this {
    return this.logical(0, rd, rn, rm, shift, amount, sf, false);
  }

  bic(rd: number, rn: number, rm: number, shift: ShiftOp = "lsl", amount = 0, sf = true): this {
    return this.logical(0, rd, rn, rm, shift, amount, sf, true);
  }

  orr(rd: number, rn: number, rm: number, shift: ShiftOp = "lsl", amount = 0, sf = true): this {
    return this.logical(1, rd, rn, rm, shift, amount, sf, false);
  }

  orn(rd: number, rn: number, rm: number, shift: ShiftOp = "lsl", amount = 0, sf = true): this {
    return this.logical(1, rd, rn, rm, shift, amount, sf, true);
  }

  eor(rd: number, rn: number, rm: number, shift: ShiftOp = "lsl", amount = 0, sf = true): this {
    return this.logical(2, rd, rn, rm, shift, amount, sf, false);
  }

  /** TST (register). */
  tst(rn: number, rm: number, shift: ShiftOp = "lsl", amount = 0, sf = true): this {
    return this.logical(3, XZR, rn, rm, shift, amount, sf, false);
  }

  /** Logical (immediate): AND/ORR/EOR/ANDS with a rotated 12-bit pattern encoded via `enc`. */
  private logicalImm(kind: number, rd: number, rn: number, encoded: number, sf: boolean): this {
    const n = (encoded >> 12) & 1;
    const immr = (encoded >> 6) & 0x3f;
    const imms = encoded & 0x3f;
    // AND/ORR/EOR/ANDS (immediate): sf + opc(2) + 100100; the 32-bit base is 0x12000000.
    return this.word((sf ? 0x92000000 : 0x12000000) | (kind << 29) | (n << 22) | (immr << 16) | (imms << 10) | (reg(rn) << 5) | reg(rd));
  }

  andImm(rd: number, rn: number, encoded: number, sf = true): this { return this.logicalImm(0, rd, rn, encoded, sf); }
  orrImm(rd: number, rn: number, encoded: number, sf = true): this { return this.logicalImm(1, rd, rn, encoded, sf); }
  eorImm(rd: number, rn: number, encoded: number, sf = true): this { return this.logicalImm(2, rd, rn, encoded, sf); }
  tstImm(rn: number, encoded: number, sf = true): this { return this.logicalImm(3, XZR, rn, encoded, sf); }

  /** Logical immediate (AND/ORR/EOR/ANDS) with a natural bitmask; throws when unencodable. */
  andMask(rd: number, rn: number, mask: bigint, kind: 0 | 1 | 2 | 3 = 0, sf = true): this {
    return this.logicalImm(kind, rd, rn, encodeLogicalImm(mask, sf), sf);
  }

  /** MOV (immediate) — ORR with a logical-immediate encoding. */
  movImm(rd: number, encoded: number, sf = true): this { return this.logicalImm(1, rd, XZR, encoded, sf); }

  mul(rd: number, rn: number, rm: number, sf = true): this {
    return this.word((sf ? 0x9b007c00 : 0x1b007c00) | (reg(rm) << 16) | (reg(rd) << 10) | (reg(rn) << 5) | reg(rd));
  }

  madd(rd: number, rn: number, rm: number, ra: number, sf = true): this {
    return this.word((sf ? 0x9b000000 : 0x1b000000) | (reg(rm) << 16) | (reg(ra) << 10) | (reg(rn) << 5) | reg(rd));
  }

  msub(rd: number, rn: number, rm: number, ra: number, sf = true): this {
    return this.word((sf ? 0x9b000000 : 0x1b000000) | 0x8000 | (reg(rm) << 16) | (reg(ra) << 10) | (reg(rn) << 5) | reg(rd));
  }

  sdiv(rd: number, rn: number, rm: number, sf = true): this {
    return this.word((sf ? 0x9ac00c00 : 0x1ac00c00) | (reg(rm) << 16) | (reg(rn) << 5) | reg(rd));
  }

  udiv(rd: number, rn: number, rm: number, sf = true): this {
    return this.word((sf ? 0x9ac00800 : 0x1ac00800) | (reg(rm) << 16) | (reg(rn) << 5) | reg(rd));
  }

  private bitfield(opc: number, rd: number, rn: number, immr: number, imms: number, sf: boolean): this {
    return this.word(0x13000000 | (sf ? 0x80000000 : 0) | (opc << 29) | (sf ? 0x400000 : 0) |
      (immr << 16) | (imms << 10) | (reg(rn) << 5) | reg(rd));
  }

  sbfm(rd: number, rn: number, immr: number, imms: number, sf = true): this { return this.bitfield(0, rd, rn, immr, imms, sf); }
  bfm(rd: number, rn: number, immr: number, imms: number, sf = true): this { return this.bitfield(1, rd, rn, immr, imms, sf); }
  ubfm(rd: number, rn: number, immr: number, imms: number, sf = true): this { return this.bitfield(2, rd, rn, immr, imms, sf); }

  sxtb(rd: number, rn: number, sf = true): this { return this.sbfm(rd, rn, 0, 7, sf); }
  sxth(rd: number, rn: number, sf = true): this { return this.sbfm(rd, rn, 0, 15, sf); }
  sxtw(rd: number, rn: number): this { return this.sbfm(rd, rn, 0, 31, true); }
  uxtb(rd: number, rn: number): this { return this.ubfm(rd, rn, 0, 7, false); }
  uxth(rd: number, rn: number): this { return this.ubfm(rd, rn, 0, 15, false); }
  /** Zero-extend the low 32 bits (`uxtw` into a 64-bit register). */
  uxtw(rd: number, rn: number): this { return this.ubfm(rd, rn, 0, 31, true); }

  /** LSL/LSR/ASR by a constant. */
  shiftImm(rd: number, rn: number, op: "lsl" | "lsr" | "asr", amount: number, sf = true): this {
    const bits = sf ? 64 : 32;
    if (amount < 0 || amount >= bits) throw new Error(`shift amount out of range: ${amount}`);
    if (op === "lsl") return this.ubfm(rd, rn, (bits - amount) % bits, bits - 1 - amount, sf);
    if (op === "lsr") return this.ubfm(rd, rn, amount, bits - 1, sf);
    return this.sbfm(rd, rn, amount, bits - 1, sf);
  }

  /** ROR by a constant (EXTR with the same register). */
  rorImm(rd: number, rn: number, amount: number, sf = true): this {
    void sf;
    return this.word((sf ? 0x93c00000 : 0x13800000) | (reg(rn) << 16) | (amount << 10) | (reg(rn) << 5) | reg(rd));
  }

  /** Variable shifts (amount in a register, taken modulo the element size). */
  lslReg(rd: number, rn: number, rm: number, sf = true): this {
    return this.word((sf ? 0x9ac02000 : 0x1ac02000) | (reg(rm) << 16) | (reg(rn) << 5) | reg(rd));
  }

  lsrReg(rd: number, rn: number, rm: number, sf = true): this {
    return this.word((sf ? 0x9ac02400 : 0x1ac02400) | (reg(rm) << 16) | (reg(rn) << 5) | reg(rd));
  }

  asrReg(rd: number, rn: number, rm: number, sf = true): this {
    return this.word((sf ? 0x9ac02800 : 0x1ac02800) | (reg(rm) << 16) | (reg(rn) << 5) | reg(rd));
  }

  rorReg(rd: number, rn: number, rm: number, sf = true): this {
    return this.word((sf ? 0x9ac02c00 : 0x1ac02c00) | (reg(rm) << 16) | (reg(rn) << 5) | reg(rd));
  }

  rev16(rd: number, rn: number, sf = false): this {
    return this.word((sf ? 0xdac00400 : 0x5ac00400) | (reg(rn) << 5) | reg(rd));
  }

  /** REV32 Xd, Xn — reverses bytes inside each 32-bit half and zeroes nothing else. */
  rev32(rd: number, rn: number): this {
    return this.word(0xdac00800 | (reg(rn) << 5) | reg(rd));
  }

  /** REV (32-bit register form): reverses the four bytes of Wn and clears the upper half. */
  rev32w(rd: number, rn: number): this {
    return this.word(0x5ac00800 | (reg(rn) << 5) | reg(rd));
  }

  rev(rd: number, rn: number, sf = true): this {
    return this.word((sf ? 0xdac00c00 : 0x5ac00800) | (reg(rn) << 5) | reg(rd));
  }

  clz(rd: number, rn: number, sf = false): this {
    return this.word((sf ? 0xdac01000 : 0x5ac01000) | (reg(rn) << 5) | reg(rd));
  }

  rbit(rd: number, rn: number, sf = false): this {
    return this.word((sf ? 0xdac00000 : 0x5ac00000) | (reg(rn) << 5) | reg(rd));
  }

  csel(rd: number, rn: number, rm: number, cond: number, sf = true): this {
    return this.condSelect(0, rd, rn, rm, cond, sf);
  }

  csinc(rd: number, rn: number, rm: number, cond: number, sf = true): this { return this.condSelect(1, rd, rn, rm, cond, sf); }
  csinv(rd: number, rn: number, rm: number, cond: number, sf = true): this { return this.condSelect(2, rd, rn, rm, cond, sf); }
  csneg(rd: number, rn: number, rm: number, cond: number, sf = true): this { return this.condSelect(3, rd, rn, rm, cond, sf); }

  /** 0 = CSEL, 1 = CSINC, 2 = CSINV, 3 = CSNEG (op = bit 30, op2 = bit 10). */
  private condSelect(which: 0 | 1 | 2 | 3, rd: number, rn: number, rm: number, cond: number, sf: boolean): this {
    return this.word((sf ? 0x9a800000 : 0x1a800000) | ((which & 2) ? 0x40000000 : 0) | ((which & 1) ? 0x400 : 0) |
      (reg(rm) << 16) | ((cond & 15) << 12) | (reg(rn) << 5) | reg(rd));
  }

  cset(rd: number, cond: number, sf = true): this {
    return this.csinc(rd, XZR, XZR, notCond(cond), sf);
  }

  csetm(rd: number, cond: number, sf = true): this {
    return this.csinv(rd, XZR, XZR, notCond(cond), sf);
  }

  // ---- Loads and stores ------------------------------------------------------------------------

  /** LDR/STR (unsigned offset, scaled). `sz` is 1, 2, 4 or 8. */
  private immLdst(isLoad: boolean, sz: number, rt: number, rn: number, off: number, signed = false): this {
    const opc = { "1u": 1, "2u": 1, "4": 1, "8": 1 }[String(sz)] ?? 1;
    void opc;
    const table: Record<string, number> = {
      "l1": 0x39400000, "s1": 0x39000000,
      "l2": 0x79400000, "s2": 0x79000000,
      "l4": 0xb9400000, "s4": 0xb9000000,
      "l8": 0xf9400000, "s8": 0xf9000000,
    };
    const key = (isLoad ? "l" : "s") + sz;
    let base = table[key];
    if (signed && sz === 1) base = 0x39800000; // LDRSB Xt (64-bit destination)
    if (signed && sz === 2) base = 0x79800000; // LDRSH Xt
    if (signed && sz === 4) base = 0xb9800000; // LDRSW Xt
    const scale = sz === 8 ? 3 : sz === 4 ? 2 : sz === 2 ? 1 : 0;
    if (off % (1 << scale)) throw new Error(`unaligned load/store offset ${off}`);
    const imm = off >> scale;
    if (off < 0 || imm >= 4096) throw new Error(`load/store offset out of range: ${off}`);
    return this.word(base | (imm << 10) | (reg(rn) << 5) | reg(rt));
  }

  ldrb(rt: number, rn: number, off = 0): this { return this.immLdst(true, 1, rt, rn, off); }
  strb(rt: number, rn: number, off = 0): this { return this.immLdst(false, 1, rt, rn, off); }
  ldrh(rt: number, rn: number, off = 0): this { return this.immLdst(true, 2, rt, rn, off); }
  strh(rt: number, rn: number, off = 0): this { return this.immLdst(false, 2, rt, rn, off); }
  ldrw(rt: number, rn: number, off = 0): this { return this.immLdst(true, 4, rt, rn, off); }
  strw(rt: number, rn: number, off = 0): this { return this.immLdst(false, 4, rt, rn, off); }
  ldrx(rt: number, rn: number, off = 0): this { return this.immLdst(true, 8, rt, rn, off); }
  strx(rt: number, rn: number, off = 0): this { return this.immLdst(false, 8, rt, rn, off); }
  ldrsb(rt: number, rn: number, off = 0): this { return this.immLdst(true, 1, rt, rn, off, true); }
  ldrsh(rt: number, rn: number, off = 0): this { return this.immLdst(true, 2, rt, rn, off, true); }
  ldrsw(rt: number, rn: number, off = 0): this { return this.immLdst(true, 4, rt, rn, off, true); }

  /** LDUR/STUR (unscaled 9-bit offset). */
  private unLdst(isLoad: boolean, sz: number, rt: number, rn: number, off: number, signed = false): this {
    const table: Record<string, number> = {
      "l1": 0x38400000, "s1": 0x38000000,
      "l2": 0x78400000, "s2": 0x78000000,
      "l4": 0xb8400000, "s4": 0xb8000000,
      "l8": 0xf8400000, "s8": 0xf8000000,
    };
    let base = table[(isLoad ? "l" : "s") + sz];
    if (signed && sz === 1) base = 0x38800000; // LDURSB Xt
    if (signed && sz === 2) base = 0x78800000; // LDURSH Xt
    if (signed && sz === 4) base = 0xb8800000; // LDURSW Xt
    if (off < -256 || off > 255) throw new Error(`unscaled offset out of range: ${off}`);
    return this.word(base | ((off & 0x1ff) << 12) | (reg(rn) << 5) | reg(rt));
  }

  ldurb(rt: number, rn: number, off: number): this { return this.unLdst(true, 1, rt, rn, off); }
  sturb(rt: number, rn: number, off: number): this { return this.unLdst(false, 1, rt, rn, off); }
  ldurh(rt: number, rn: number, off: number): this { return this.unLdst(true, 2, rt, rn, off); }
  sturh(rt: number, rn: number, off: number): this { return this.unLdst(false, 2, rt, rn, off); }
  ldur(rt: number, rn: number, off: number): this { return this.unLdst(true, 4, rt, rn, off); }
  stur(rt: number, rn: number, off: number): this { return this.unLdst(false, 4, rt, rn, off); }
  ldurx(rt: number, rn: number, off: number): this { return this.unLdst(true, 8, rt, rn, off); }
  sturx(rt: number, rn: number, off: number): this { return this.unLdst(false, 8, rt, rn, off); }
  ldursb(rt: number, rn: number, off: number): this { return this.unLdst(true, 1, rt, rn, off, true); }
  ldursh(rt: number, rn: number, off: number): this { return this.unLdst(true, 2, rt, rn, off, true); }
  ldursw(rt: number, rn: number, off: number): this { return this.unLdst(true, 4, rt, rn, off, true); }

  /** LDR/STR with a register offset: `ldr w0, [x1, w2, uxtw]` (byte-scaled). */
  ldrReg(sz: number, rt: number, rn: number, rm: number, option: 2 | 3 = 2): this {
    const table: Record<number, number> = { 1: 0x38600800, 2: 0x78600800, 4: 0xb8600800, 8: 0xf8600800 };
    return this.word(table[sz] | (reg(rm) << 16) | ((option === 3 ? 6 : 2) << 13) | (reg(rn) << 5) | reg(rt));
  }

  strReg(sz: number, rt: number, rn: number, rm: number, option: 2 | 3 = 2): this {
    const table: Record<number, number> = { 1: 0x38200800, 2: 0x78200800, 4: 0xb8200800, 8: 0xf8200800 };
    return this.word(table[sz] | (reg(rm) << 16) | ((option === 3 ? 6 : 2) << 13) | (reg(rn) << 5) | reg(rt));
  }

  ldrsbReg(rt: number, rn: number, rm: number): this {
    return this.word(0x38a00800 | (reg(rm) << 16) | (2 << 13) | (reg(rn) << 5) | reg(rt));
  }

  ldrshReg(rt: number, rn: number, rm: number): this {
    return this.word(0x78a00800 | (reg(rm) << 16) | (2 << 13) | (reg(rn) << 5) | reg(rt));
  }

  ldrswReg(rt: number, rn: number, rm: number): this {
    return this.word(0xb8a00800 | (reg(rm) << 16) | (2 << 13) | (reg(rn) << 5) | reg(rt));
  }

  /** LDP/STP with a signed scaled offset (`sz` 4 or 8). */
  pair(isLoad: boolean, rt: number, rt2: number, rn: number, off: number, sz: 4 | 8): this {
    if (off % sz) throw new Error(`unaligned pair offset ${off}`);
    const imm7 = off / sz;
    if (imm7 < -64 || imm7 > 63) throw new Error(`pair offset out of range: ${off}`);
    const base = sz === 8 ? 0xa9000000 : 0x29000000;
    return this.word(base | (isLoad ? 0x00400000 : 0) | ((imm7 & 0x7f) << 15) | (reg(rt2) << 10) | (reg(rn) << 5) | reg(rt));
  }

  ldp(rt: number, rt2: number, rn: number, off = 0): this { return this.pair(true, rt, rt2, rn, off, 8); }
  stp(rt: number, rt2: number, rn: number, off = 0): this { return this.pair(false, rt, rt2, rn, off, 8); }
  ldpw(rt: number, rt2: number, rn: number, off = 0): this { return this.pair(true, rt, rt2, rn, off, 4); }
  stpw(rt: number, rt2: number, rn: number, off = 0): this { return this.pair(false, rt, rt2, rn, off, 4); }

  /** Pre-indexed STP (writes the adjusted base back): `stp x29, x30, [sp, #-16]!`. */
  stpPre(rt: number, rt2: number, rn: number, off: number): this {
    if (off % 8) throw new Error("unaligned pre-indexed pair");
    return this.word(0xa9800000 | (((off / 8) & 0x7f) << 15) | (reg(rt2) << 10) | (reg(rn) << 5) | reg(rt));
  }

  ldpPost(rt: number, rt2: number, rn: number, off: number): this {
    if (off % 8) throw new Error("unaligned post-indexed pair");
    return this.word(0xa8c00000 | (((off / 8) & 0x7f) << 15) | (reg(rt2) << 10) | (reg(rn) << 5) | reg(rt));
  }

  ldrLit(rt: number, label: string): this {
    const at = this.ensure(4);
    this.dv.setUint32(at, 0x58000000 | reg(rt), true);
    this.fixups.push({ at, label, kind: "lit", patchShift: 5, patchMask: 0x7ffff });
    return this;
  }

  ldrwLit(rt: number, label: string): this {
    const at = this.ensure(4);
    this.dv.setUint32(at, 0x18000000 | reg(rt), true);
    this.fixups.push({ at, label, kind: "lit", patchShift: 5, patchMask: 0x7ffff });
    return this;
  }

  /** ADR: PC-relative address, +/- 1 MiB (immlo in bits 30-29, immhi in 23-5). */
  adr(rd: number, label: string): this {
    const at = this.ensure(4);
    this.dv.setUint32(at, 0x10000000 | reg(rd), true);
    this.fixups.push({ at, label, kind: "adr", patchShift: 0, patchMask: 0 });
    return this;
  }

  // ---- Floating point (scalar) ------------------------------------------------------------------

  private fp2(sf64: boolean, op: number, rd: number, rn: number, rm: number): this {
    return this.word((sf64 ? 0x1e600800 : 0x1e200800) | (op << 12) | (reg(rm) << 16) | (reg(rn) << 5) | reg(rd));
  }

  fmul(sf64: boolean, rd: number, rn: number, rm: number): this { return this.fp2(sf64, 0x0, rd, rn, rm); }
  fdiv(sf64: boolean, rd: number, rn: number, rm: number): this { return this.fp2(sf64, 0x1, rd, rn, rm); }
  fadd(sf64: boolean, rd: number, rn: number, rm: number): this { return this.fp2(sf64, 0x2, rd, rn, rm); }
  fsub(sf64: boolean, rd: number, rn: number, rm: number): this { return this.fp2(sf64, 0x3, rd, rn, rm); }
  fmax(sf64: boolean, rd: number, rn: number, rm: number): this { return this.fp2(sf64, 0x4, rd, rn, rm); }
  fmin(sf64: boolean, rd: number, rn: number, rm: number): this { return this.fp2(sf64, 0x5, rd, rn, rm); }
  fnmul(sf64: boolean, rd: number, rn: number, rm: number): this { return this.fp2(sf64, 0x8, rd, rn, rm); }

  /** FP one-source data processing; the base word selects precision (single/double). */
  private fp1(sf64: boolean, single: number, opcode: number, rd: number, rn: number): this {
    // The double form sets bit 22 (ftype = 01) relative to the single-precision encoding.
    return this.word((sf64 ? single + 0x400000 : single) | (opcode << 15) | (reg(rn) << 5) | reg(rd));
  }

  fmov(sf64: boolean, rd: number, rn: number): this { return this.fp1(sf64, 0x1e204000, 0, rd, rn); }
  fabs(sf64: boolean, rd: number, rn: number): this { return this.fp1(sf64, 0x1e20c000, 0, rd, rn); }
  fneg(sf64: boolean, rd: number, rn: number): this { return this.fp1(sf64, 0x1e214000, 0, rd, rn); }
  fsqrt(sf64: boolean, rd: number, rn: number): this { return this.fp1(sf64, 0x1e21c000, 0, rd, rn); }

  /** FRINTN 8, FRINTP 9, FRINTM 10, FRINTZ 11, FRINTA 12. */
  frint(sf64: boolean, rd: number, rn: number, mode: "n" | "p" | "m" | "z" | "a"): this {
    const opcode = { n: 8, p: 9, m: 10, z: 11, a: 12 }[mode];
    return this.fp1(sf64, 0x1e244000, opcode, rd, rn);
  }

  fcmp(sf64: boolean, rn: number, rm: number): this {
    return this.word((sf64 ? 0x1e602000 : 0x1e202000) | (reg(rm) << 16) | (reg(rn) << 5));
  }

  fcmpZero(sf64: boolean, rn: number): this {
    return this.word((sf64 ? 0x1e602000 : 0x1e202000) | (reg(rn) << 5));
  }

  /** FMOV to/from general registers (bit copy). */
  fmovToGpr(sf64: boolean, rd: number, rn: number): this {
    return this.word((sf64 ? 0x9e660000 : 0x1e260000) | (reg(rn) << 5) | reg(rd));
  }

  fmovFromGpr(sf64: boolean, rd: number, rn: number): this {
    return this.word((sf64 ? 0x9e670000 : 0x1e270000) | (reg(rn) << 5) | reg(rd));
  }

  /** SCVTF: float destination, integer source. */
  scvtf(dstDouble: boolean, src64: boolean, unsigned: boolean, rd: number, rn: number): this {
    return this.word(0x1e220000 | (dstDouble ? 0x400000 : 0) | (src64 ? 0x80000000 : 0) | (unsigned ? 0x10000 : 0) |
      (reg(rn) << 5) | reg(rd));
  }

  /** FCVTZS/FCVTZU: integer destination, float source. */
  fcvtz(dst64: boolean, srcDouble: boolean, unsigned: boolean, rd: number, rn: number): this {
    return this.word(0x1e380000 | (dst64 ? 0x80000000 : 0) | (srcDouble ? 0x400000 : 0) | (unsigned ? 0x10000 : 0) |
      (reg(rn) << 5) | reg(rd));
  }

  /** FCVT between single and double. */
  fcvt(rd: number, rn: number, toDouble: boolean): this {
    return this.word((toDouble ? 0x1e624000 : 0x1e22c000) | (reg(rn) << 5) | reg(rd));
  }

  /** LDR/STR of a scalar FP register (`ldr d0, [x1, #8]`). */
  fldr(sz: 4 | 8, rt: number, rn: number, off: number): this {
    const scale = sz === 8 ? 3 : 2;
    if (off < 0 || off % sz || (off >> scale) >= 4096) throw new Error(`fp load offset out of range: ${off}`);
    return this.word((sz === 8 ? 0xfd400000 : 0xbd400000) | ((off >> scale) << 10) | (reg(rn) << 5) | reg(rt));
  }

  fstr(sz: 4 | 8, rt: number, rn: number, off: number): this {
    const scale = sz === 8 ? 3 : 2;
    if (off < 0 || off % sz || (off >> scale) >= 4096) throw new Error(`fp store offset out of range: ${off}`);
    return this.word((sz === 8 ? 0xfd000000 : 0xbd000000) | ((off >> scale) << 10) | (reg(rn) << 5) | reg(rt));
  }

  ldurd(rt: number, rn: number, off: number): this {
    if (off < -256 || off > 255) throw new Error("fp ldur offset out of range");
    return this.word(0xfc400000 | ((off & 0x1ff) << 12) | (reg(rn) << 5) | reg(rt));
  }

  /** `ldr d0, [x9, w10, uxtw]` — byte offset in a register. */
  fldrReg(sz: 4 | 8, rt: number, rn: number, rm: number, option: "uxtw" | "lsl" = "uxtw"): this {
    return this.word((sz === 8 ? 0xfc600000 : 0xbc600000) | (reg(rm) << 16) | (option === "lsl" ? 3 << 13 : 2 << 13) | 0x800 |
      (reg(rn) << 5) | reg(rt));
  }

  fstrReg(sz: 4 | 8, rt: number, rn: number, rm: number, option: "uxtw" | "lsl" = "uxtw"): this {
    return this.word((sz === 8 ? 0xfc200000 : 0xbc200000) | (reg(rm) << 16) | (option === "lsl" ? 3 << 13 : 2 << 13) | 0x800 |
      (reg(rn) << 5) | reg(rt));
  }

  fcsel(sf64: boolean, rd: number, rn: number, rm: number, cond: number): this {
    return this.word((sf64 ? 0x1e600c00 : 0x1e200c00) | (reg(rm) << 16) | ((cond & 15) << 12) | (reg(rn) << 5) | reg(rd));
  }

  // ---- Barriers --------------------------------------------------------------------------------

  dsb(option = 0xb): this { return this.word(0xd503309f | (option << 8)); }
  dmb(option = 0xb): this { return this.word(0xd50330bf | (option << 8)); }
  isb(): this { return this.word(0xd5033fdf); }

  /** `dc cvau` / `ic ivau` for the address in `rt`, then DSB/ISB (icache_flush trampoline). */
  icacheFlushSequence(rt: number): this {
    return this.word(0xd50b7b20 | (reg(rt) << 5)) // dc cvau, xN
      .word(0xd5033bbf) // dsb ish
      .word(0xd50b7520 | (reg(rt) << 5)) // ic ivau, xN
      .word(0xd5033bbf) // dsb ish
      .isb();
  }
}

export const alignUp = (v: number, a: number) => (v + a - 1) & ~(a - 1);

/**
 * Encode a natural bitmask as an AArch64 logical immediate (N:immr:imms), the 13-bit field used by
 * AND/ORR/EOR/ANDS (immediate). Returns the field; throws when the mask is not a rotated run of
 * ones repeated to fill the register (i.e. not encodable).
 */
export function encodeLogicalImm(mask: bigint, sf = true): number {
  const width = sf ? 64 : 32;
  const m = BigInt.asUintN(width, mask);
  if (m === 0n || m === BigInt.asUintN(width, -1n)) throw new Error("logical immediate cannot be all zeros or all ones");
  for (let esize = 2; esize <= width; esize *= 2) {
    const emask = (1n << BigInt(esize)) - 1n;
    const elem = m & emask;
    let repeats = true;
    for (let b = esize; b < width; b += esize) {
      if (((m >> BigInt(b)) & emask) !== elem) { repeats = false; break; }
    }
    if (!repeats) continue;
    let ones = 0;
    for (let i = 0; i < esize; i++) if ((elem >> BigInt(i)) & 1n) ones++;
    if (ones === 0) continue;
    const run = (1n << BigInt(ones)) - 1n;
    for (let r = 0; r < esize; r++) {
      const v = BigInt.asUintN(esize, (run >> BigInt(r)) | (run << BigInt(esize - r)));
      if (v !== elem) continue;
      // N:immr:imms. imms keeps the element size in its high bits: the complement of log2(esize),
      // then ones-1 in the low log2(esize) bits (DecodeBitMasks in the ARM ARM).
      let n: number;
      let imms: number;
      if (esize === 64) {
        n = 1;
        imms = ones - 1;
      } else {
        // The decoder derives the element size from HighestSetBit(N:NOT(imms)) = log2(esize), so
        // NOT(imms) must have its top bit exactly there; the low bits carry ones-1.
        const len = Math.log2(esize);
        n = 0;
        // Bits of imms above `len` are 1, bit `len` is 0, and the low bits hold ones-1, so that
        // HighestSetBit(N:NOT(imms)) == len (which is how the decoder recovers the element size).
        imms = (((0x3f << (len + 1)) & 0x3f) | (ones - 1)) & 0x3f;
      }
      return (n << 12) | ((r & 0x3f) << 6) | imms;
    }
  }
  throw new Error(`mask 0x${m.toString(16)} is not a logical immediate`);
}

/**
 * Split `value` into up to `max` add/sub immediate steps (0-2 per instruction, 12 bits + shift).
 * Returns null when the constant needs more steps than allowed.
 */
export function addImmSteps(value: number, max: number): { neg: boolean; imm: number; shift12: boolean }[] | null {
  const v = value | 0;
  if (v >= 0 && v <= 0xfff) return [{ neg: false, imm: v, shift12: false }];
  if (v >= 0 && v <= 0xfff000 && v % 0x1000 === 0) return [{ neg: false, imm: v >>> 12, shift12: true }];
  const neg = v < 0;
  const mag = Math.abs(v);
  if (mag > 0xffffff) return null;
  const lo = mag & 0xfff;
  const hi = mag >>> 12;
  const steps: { neg: boolean; imm: number; shift12: boolean }[] = [];
  if (hi) steps.push({ neg, imm: hi, shift12: true });
  if (lo) steps.push({ neg, imm: lo, shift12: false });
  if (steps.length > (hi ? 2 : 1) || steps.length > max) return null;
  return steps;
}

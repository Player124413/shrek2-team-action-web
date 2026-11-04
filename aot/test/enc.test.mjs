// Verifies the ARM64 encoder against a real CPU model: each case assembles a short program, the
// Python runner (run-enc.py) executes it in Unicorn's ARM64 emulation and compares every register
// and memory word it touched with the intended semantics. Any wrong encoding fails here rather
// than on a phone.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Assembler, Cond, encodeLogicalImm } from "../src/arm64.ts";

const CODE = 0x100000;
const DATA = 0x400000;

const cases = [];

/** Assemble one program; `setup.regs` are written before it runs, `expect` is verified after. */
function test(name, build, setup = {}, expect = {}) {
  const a = new Assembler();
  build(a);
  const code = a.finish();
  cases.push({
    name,
    code: Buffer.from(code).toString("hex"),
    regs: Object.fromEntries(Object.entries(setup.regs ?? {}).map(([k, v]) => [k, String(BigInt(v))])),
    sp: setup.sp === undefined ? "4194304" : String(BigInt(setup.sp)),
    mem: (setup.mem ?? []).map(([addr, bytes]) => [String(BigInt(addr)), Buffer.from(bytes).toString("hex")]),
    dregs: Object.fromEntries(Object.entries(setup.dregs ?? {}).map(([k, v]) => [k, String(fb(v))])),
    expect: {
      regs: Object.fromEntries(Object.entries(expect.regs ?? {}).map(([k, v]) => [k, String(BigInt(v))])),
      dregs: Object.fromEntries(Object.entries(expect.dregs ?? {}).map(([k, v]) => [k, String(fb(v))])),
      mem: (expect.mem ?? []).map(([addr, bytes]) => [String(BigInt(addr)), Buffer.from(bytes).toString("hex")]),
    },
  });
}

const M = (1n << 64n) - 1n;
const u64 = (v) => BigInt.asUintN(64, BigInt(v));
const bitsF64 = (v) => new DataView(new Float64Array([v]).buffer).getBigUint64(0, true);
const bitsF32 = (v) => new DataView(new Float32Array([v]).buffer).getUint32(0, true);
/** Case values are plain doubles in JS; the runner needs their bit patterns. */
const fb = (v) => (typeof v === "bigint" ? v : bitsF64(v));

// ---- Moves and constants ---------------------------------------------------------------------
for (const v of [0n, 1n, 0x1234n, 0x12345678n, 0xdeadbeefcafebaben, M, 0x5555555555555555n, 0x8000000000000000n,
  0xffff0000n, 0x0000ffff0000ffffn, 0x7fffffffffffffffn, 0xffffffffn]) {
  test(`movConst ${v.toString(16)}`, (a) => a.movConst(0, v), {}, { regs: { x0: v } });
}
for (const v of [0, 1, 0x1234, 0xffffffff, 0xdeadbeef]) {
  test(`movConst32 ${v.toString(16)}`, (a) => a.movConst32(0, v), {}, { regs: { x0: v >>> 0 } });
}
test("mov x0,x1", (a) => a.mov(0, 1), { regs: { x1: 0x1234 } }, { regs: { x0: 0x1234 } });
test("mov w0,w1 clears upper", (a) => a.movw(0, 1), { regs: { x1: 0xffffffff12345678n } }, { regs: { x0: 0x12345678 } });
test("mvn", (a) => a.mvn(0, 1), { regs: { x1: 0x1234567812345678n } }, { regs: { x0: ~0x1234567812345678n & M } });
for (const mask of [0xffn, 1n, 1n << 20n, 0xffff0000n, 0xf0f0f0f0f0f0f0f0n, 0x7fn, 0xfffffffffffffffen, 0xffffffn]) {
  test(`andMask ${mask.toString(16)}`, (a) => a.andMask(0, 1, mask), { regs: { x1: 0xffffffffffffffffn } },
    { regs: { x0: mask } });
  test(`orrMask ${mask.toString(16)}`, (a) => a.andMask(0, 1, mask, 1), { regs: { x1: 0 } }, { regs: { x0: mask } });
  test(`eorMask ${mask.toString(16)}`, (a) => a.andMask(0, 1, mask, 2), { regs: { x1: mask } }, { regs: { x0: 0 } });
  test(`andMask32 ${mask.toString(16)}`, (a) => a.andMask(0, 1, mask, 0, false), { regs: { x1: 0xffffffffn } },
    { regs: { x0: mask & 0xffffffffn } });
}

// ---- Arithmetic ------------------------------------------------------------------------------
for (const [a1, a2] of [[7n, 3n], [M, 1n], [0n, 0n], [0x1234567887654321n, 0x1111111111111111n], [5n, M]]) {
  const tag = `${a1.toString(16)}/${a2.toString(16)}`;
  test(`add ${tag}`, (a) => a.add(0, 1, 2), { regs: { x1: a1, x2: a2 } }, { regs: { x0: u64(a1 + a2) } });
  test(`sub ${tag}`, (a) => a.sub(0, 1, 2), { regs: { x1: a1, x2: a2 } }, { regs: { x0: u64(a1 - a2) } });
  test(`mul ${tag}`, (a) => a.mul(0, 1, 2), { regs: { x1: a1, x2: a2 } }, { regs: { x0: u64(a1 * a2) } });
  test(`and ${tag}`, (a) => a.and(0, 1, 2), { regs: { x1: a1, x2: a2 } }, { regs: { x0: a1 & a2 } });
  test(`orr ${tag}`, (a) => a.orr(0, 1, 2), { regs: { x1: a1, x2: a2 } }, { regs: { x0: a1 | a2 } });
  test(`eor ${tag}`, (a) => a.eor(0, 1, 2), { regs: { x1: a1, x2: a2 } }, { regs: { x0: a1 ^ a2 } });
  test(`bic ${tag}`, (a) => a.bic(0, 1, 2), { regs: { x1: a1, x2: a2 } }, { regs: { x0: a1 & (~a2 & M) } });
  test(`orn ${tag}`, (a) => a.orn(0, 1, 2), { regs: { x1: a1, x2: a2 } }, { regs: { x0: a1 | (~a2 & M) } });
}
test("add imm", (a) => a.addSubImm("add", 0, 1, 1234), { regs: { x1: 100 } }, { regs: { x0: 1334 } });
test("sub imm", (a) => a.addSubImm("sub", 0, 1, 1234), { regs: { x1: 100 } }, { regs: { x0: u64(-1134n) } });
test("add imm lsl12", (a) => a.addSubImmShifted("add", 0, 1, 1, true), { regs: { x1: 1 } }, { regs: { x0: 4097 } });
test("addExt sp", (a) => a.addExtended(0, 31, 2), { sp: 0x1000, regs: { x2: 0x234 } }, { regs: { x0: 0x1234 } });
test("subExt", (a) => a.subExtended(0, 1, 2), { regs: { x1: 10, x2: 3 } }, { regs: { x0: 7 } });
test("addExt uxtw", (a) => a.addExtended(0, 1, 2, 2), { regs: { x1: 10, x2: 0xffffffffffffffffn } }, { regs: { x0: 10 + 0xffffffff } });

for (const [a1, a2] of [[7n, 3n], [u64(-7n), 3n], [u64(-7n), u64(-3n)], [M, M], [123n, 45n]]) {
  const tag = `${BigInt.asIntN(64, a1)}/${BigInt.asIntN(64, a2)}`;
  test(`sdiv ${tag}`, (a) => a.sdiv(0, 1, 2), { regs: { x1: a1, x2: a2 } },
    { regs: { x0: u64(BigInt.asIntN(64, a1) / BigInt.asIntN(64, a2)) } });
  test(`udiv ${tag}`, (a) => a.udiv(0, 1, 2), { regs: { x1: a1, x2: a2 } }, { regs: { x0: u64(a1 / a2) } });
  test(`msub ${tag}`, (a) => a.msub(0, 1, 2, 3), { regs: { x1: a1, x2: a2, x3: 5 } }, { regs: { x0: u64(5n - a1 * a2) } });
  test(`madd ${tag}`, (a) => a.madd(0, 1, 2, 3), { regs: { x1: a1, x2: a2, x3: 5 } }, { regs: { x0: u64(5n + a1 * a2) } });
}

// ---- Shifts, bitfield moves, bit counting ------------------------------------------------------
for (const v of [0n, 1n, 0x8000000000000000n, 0x123456789abcdefn, M, 0x80000000n]) {
  for (const n of [0, 1, 31, 32, 63]) {
    test(`lsl #${n}`, (a) => a.shiftImm(0, 1, "lsl", n), { regs: { x1: v } }, { regs: { x0: u64(v << BigInt(n)) } });
    test(`lsr #${n}`, (a) => a.shiftImm(0, 1, "lsr", n), { regs: { x1: v } }, { regs: { x0: u64(v >> BigInt(n)) } });
    test(`asr #${n}`, (a) => a.shiftImm(0, 1, "asr", n), { regs: { x1: v } }, { regs: { x0: u64(BigInt.asIntN(64, v) >> BigInt(n)) } });
    test(`ror #${n}`, (a) => a.rorImm(0, 1, n), { regs: { x1: v } }, { regs: { x0: u64((v >> BigInt(n)) | (v << BigInt(64 - n))) } });
  }
  const v32 = v & 0xffffffffn;
  test("rev16", (a) => a.rev16(0, 1), { regs: { x1: v } },
    { regs: { x0: BigInt.asUintN(32, ((v32 & 0xffn) << 8n) | ((v32 >> 8n) & 0xffn) | ((v32 & 0xff0000n) << 8n) | ((v32 >> 8n) & 0xff0000n)) } });
  const rev8 = (x, win) => { let r = 0n; for (let i = 0; i < win; i += 8) r |= ((x >> BigInt(i)) & 0xffn) << BigInt(win - 8 - i); return r; };
  test("rev32w", (a) => a.rev32w(0, 1), { regs: { x1: v } }, { regs: { x0: rev8(v32, 32) } });
  test("rev32", (a) => a.rev32(0, 1), { regs: { x1: v } }, { regs: { x0: rev8(v & 0xffffffffn, 32) | (rev8(v >> 32n, 32) << 32n) } });
  test("rev64", (a) => a.rev(0, 1), { regs: { x1: v } },
    { regs: { x0: BigInt("0x" + v.toString(16).padStart(16, "0").match(/../g).reverse().join("")) } });
  test("clz", (a) => a.clz(0, 1), { regs: { x1: v } }, { regs: { x0: v32 === 0n ? 32 : Math.clz32(Number(v32)) } });
  test("rbit", (a) => a.rbit(0, 1), { regs: { x1: v } },
    { regs: { x0: BigInt("0b" + v32.toString(2).padStart(32, "0").split("").reverse().join("")) } });
  test("sxtb", (a) => a.sxtb(0, 1), { regs: { x1: v } }, { regs: { x0: u64(BigInt.asIntN(8, v)) } });
  test("sxth", (a) => a.sxth(0, 1), { regs: { x1: v } }, { regs: { x0: u64(BigInt.asIntN(16, v)) } });
  test("sxtw", (a) => a.sxtw(0, 1), { regs: { x1: v } }, { regs: { x0: u64(BigInt.asIntN(32, v)) } });
  test("uxtb", (a) => a.uxtb(0, 1), { regs: { x1: v } }, { regs: { x0: v & 0xffn } });
  test("uxth", (a) => a.uxth(0, 1), { regs: { x1: v } }, { regs: { x0: v & 0xffffn } });
  test("uxtw", (a) => a.uxtw(0, 1), { regs: { x1: v } }, { regs: { x0: v32 } });
  for (const n of [0n, 5n, 31n, 32n, 63n, 64n, 65n, M]) {
    const s = n & 63n;
    test(`lslReg ${n}`, (a) => a.lslReg(0, 1, 2), { regs: { x1: v, x2: n } }, { regs: { x0: u64(v << s) } });
    test(`lsrReg ${n}`, (a) => a.lsrReg(0, 1, 2), { regs: { x1: v, x2: n } }, { regs: { x0: u64(v >> s) } });
    test(`asrReg ${n}`, (a) => a.asrReg(0, 1, 2), { regs: { x1: v, x2: n } }, { regs: { x0: u64(BigInt.asIntN(64, v) >> s) } });
    test(`rorReg ${n}`, (a) => a.rorReg(0, 1, 2), { regs: { x1: v, x2: n } }, { regs: { x0: u64((v >> s) | (v << (64n - s))) } });
  }
}

// ---- Conditional select, set, compare ---------------------------------------------------------
for (const [a1, a2] of [[5n, 9n], [9n, 5n], [5n, 5n], [M, 0n], [u64(-1n), 1n]]) {
  const tag = `${BigInt.asIntN(64, a1)}/${BigInt.asIntN(64, a2)}`;
  const lt = BigInt.asIntN(64, a1) < BigInt.asIntN(64, a2);
  const base = { regs: { x1: a1, x2: a2, x3: 111, x4: 222 } };
  test(`csel eq ${tag}`, (a) => { a.cmpReg(1, 2); a.csel(0, 3, 4, Cond.EQ); }, base, { regs: { x0: a1 === a2 ? 111 : 222 } });
  test(`csel lt ${tag}`, (a) => { a.cmpReg(1, 2); a.csel(0, 3, 4, Cond.LT); }, base, { regs: { x0: lt ? 111 : 222 } });
  test(`cset eq ${tag}`, (a) => { a.cmpReg(1, 2); a.cset(0, Cond.EQ); }, base, { regs: { x0: a1 === a2 ? 1 : 0 } });
  test(`csetm lt ${tag}`, (a) => { a.cmpReg(1, 2); a.csetm(0, Cond.LT); }, base, { regs: { x0: lt ? M : 0 } });
  test(`csneg lt ${tag}`, (a) => { a.cmpReg(1, 2); a.csneg(0, 3, 4, Cond.LT); }, base, { regs: { x0: lt ? 111 : u64(-222n) } });
  test(`csinc eq ${tag}`, (a) => { a.cmpReg(1, 2); a.csinc(0, 3, 4, Cond.EQ); }, base, { regs: { x0: a1 === a2 ? 111 : 223 } });
  test(`csinv eq ${tag}`, (a) => { a.cmpReg(1, 2); a.csinv(0, 3, 4, Cond.EQ); }, base, { regs: { x0: a1 === a2 ? 111 : ~222n & M } });
}
test("cmpImm eq", (a) => { a.cmpImm(1, 10); a.csel(0, 3, 4, Cond.EQ); }, { regs: { x1: 10, x3: 1, x4: 2 } }, { regs: { x0: 1 } });
test("cset cs", (a) => { a.cmpReg(1, 2); a.cset(0, Cond.CS); }, { regs: { x1: 7, x2: 5 } }, { regs: { x0: 1 } });
test("cset hi", (a) => { a.cmpReg(1, 2); a.cset(0, Cond.HI); }, { regs: { x1: 7, x2: 7 } }, { regs: { x0: 0 } });
test("cmnImm", (a) => { a.cmnImm(1, 0x100); a.csel(0, 3, 4, Cond.EQ); }, { regs: { x1: u64(-0x100n), x3: 1, x4: 2 } }, { regs: { x0: 1 } });
test("tstReg", (a) => { a.tst(1, 2); a.csel(0, 3, 4, Cond.NE); }, { regs: { x1: 0b110, x2: 0b100, x3: 1, x4: 2 } }, { regs: { x0: 1 } });
test("tstImm", (a) => { a.tstImm(1, encodeLogicalImm(0x80n)); a.csel(0, 3, 4, Cond.NE); }, { regs: { x1: 0x80, x3: 1, x4: 2 } }, { regs: { x0: 1 } });
test("tstImm z", (a) => { a.tstImm(1, encodeLogicalImm(0x80n)); a.csel(0, 3, 4, Cond.NE); }, { regs: { x1: 0x81, x3: 1, x4: 2 } }, { regs: { x0: 1 } });

// ---- Branches ---------------------------------------------------------------------------------
test("cbnz taken", (a) => {
  const f = a.fresh();
  a.cbnz(1, f);
  a.movConst(0, 1);
  const end = a.fresh();
  a.b(end);
  a.bind(f);
  a.movConst(0, 2);
  a.bind(end);
}, { regs: { x1: 3 } }, { regs: { x0: 2 } });
test("cbnz not taken", (a) => {
  const f = a.fresh();
  a.cbnz(1, f);
  a.movConst(0, 1);
  const end = a.fresh();
  a.b(end);
  a.bind(f);
  a.movConst(0, 2);
  a.bind(end);
}, { regs: { x1: 0 } }, { regs: { x0: 1 } });
test("cbz taken", (a) => {
  const f = a.fresh();
  a.cbz(1, f);
  a.movConst(0, 1);
  const end = a.fresh();
  a.b(end);
  a.bind(f);
  a.movConst(0, 2);
  a.bind(end);
}, { regs: { x1: 0 } }, { regs: { x0: 2 } });
test("cbz 32-bit", (a) => {
  // The 32-bit compare sees x1's low word, which is zero here, so the branch is taken.
  const f = a.fresh();
  a.movConst(0, 8);
  a.cbz(1, f, false);
  a.movConst(0, 9);
  a.bind(f);
}, { regs: { x1: 0x100000000n } }, { regs: { x0: 8 } });
test("cbnz 32-bit taken", (a) => {
  const f = a.fresh();
  a.movConst(0, 8);
  a.cbnz(1, f, false);
  a.movConst(0, 9);
  a.bind(f);
}, { regs: { x1: 1n } }, { regs: { x0: 8 } });
test("bcond NE taken", (a) => {
  a.movConst(0, 7);
  const f = a.fresh();
  a.cmpReg(1, 2);
  a.bcond(Cond.NE, f);
  a.movConst(0, 9);
  a.bind(f);
}, { regs: { x1: 3, x2: 4 } }, { regs: { x0: 7 } });
test("bcond NE not taken", (a) => {
  a.movConst(0, 7);
  const f = a.fresh();
  a.cmpReg(1, 2);
  a.bcond(Cond.NE, f);
  a.movConst(0, 9);
  a.bind(f);
}, { regs: { x1: 3, x2: 3 } }, { regs: { x0: 9 } });
test("bl + ret", (a) => {
  // Layout: entry -> b end; sub: x0 = 42; ret; end: bl sub; then fall through.
  const end = a.fresh();
  const sub = a.fresh();
  a.b(end);
  a.bind(sub);
  a.movConst(0, 42);
  a.ret();
  a.bind(end);
  a.bl(sub);
}, {}, { regs: { x0: 42 } });
test("adr + blr + br", (a) => {
  // The stub is reached through its own address (ADR), called with BLR and returns with BR x30.
  const stub = a.fresh();
  const done = a.fresh();
  a.adr(9, stub);
  a.blr(9);
  a.movConst(0, 1);
  a.b(done);
  a.bind(stub);
  a.movConst(0, 0x1234);
  a.br(30);
  a.bind(done);
}, {}, { regs: { x0: 1, x9: CODE + 16 } });

// ---- Loads and stores -------------------------------------------------------------------------
for (const off of [0, 8, 2040]) {
  test(`ldrw +${off}`, (a) => a.ldrw(0, 9, off), { regs: { x9: DATA }, mem: [[DATA + off, [0x78, 0x56, 0x34, 0x12]]] },
    { regs: { x0: 0x12345678 } });
  test(`strw +${off}`, (a) => a.strw(8, 9, off), { regs: { x9: DATA, x8: 0xaabbccdd12345678n } },
    { mem: [[DATA + off, [0x78, 0x56, 0x34, 0x12]]] });
}
test("ldrb", (a) => a.ldrb(0, 9), { regs: { x9: DATA }, mem: [[DATA, [0xab]]] }, { regs: { x0: 0xab } });
test("strb", (a) => a.strb(8, 9), { regs: { x9: DATA, x8: 0x1234 } }, { mem: [[DATA, [0x34]]] });
test("ldrh", (a) => a.ldrh(0, 9), { regs: { x9: DATA }, mem: [[DATA, [0xcd, 0xab]]] }, { regs: { x0: 0xabcd } });
test("strh", (a) => a.strh(8, 9), { regs: { x9: DATA, x8: 0x1234 } }, { mem: [[DATA, [0x34, 0x12]]] });
test("ldrx", (a) => a.ldrx(0, 9), { regs: { x9: DATA }, mem: [[DATA, [1, 2, 3, 4, 5, 6, 7, 8]]] }, { regs: { x0: 0x0807060504030201n } });
test("strx", (a) => a.strx(8, 9), { regs: { x9: DATA, x8: 0x1122334455667788n } }, { mem: [[DATA, [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11]]] });
test("ldrsb", (a) => a.ldrsb(0, 9), { regs: { x9: DATA }, mem: [[DATA, [0xfe]]] }, { regs: { x0: u64(-2n) } });
test("ldrsh", (a) => a.ldrsh(0, 9), { regs: { x9: DATA }, mem: [[DATA, [0x00, 0x80]]] }, { regs: { x0: u64(-32768n) } });
test("ldrsw", (a) => a.ldrsw(0, 9), { regs: { x9: DATA }, mem: [[DATA, [0, 0, 0, 0x80]]] }, { regs: { x0: u64(-2147483648n) } });
for (const off of [-8, -256, 255]) {
  test(`ldurh ${off}`, (a) => a.ldurh(0, 9, off), { regs: { x9: DATA + 512 }, mem: [[DATA + 512 + off, [0x78, 0x56]]] },
    { regs: { x0: 0x5678 } });
  test(`ldurw ${off}`, (a) => a.ldur(0, 9, off), { regs: { x9: DATA + 512 }, mem: [[DATA + 512 + off, [1, 2, 3, 4]]] },
    { regs: { x0: 0x04030201 } });
  test(`sturx ${off}`, (a) => a.sturx(8, 9, off), { regs: { x9: DATA + 512, x8: 0x0102030405060708n } },
    { mem: [[DATA + 512 + off, [8, 7, 6, 5, 4, 3, 2, 1]]] });
}
test("ldrb unscaled", (a) => a.ldurb(0, 9, -1), { regs: { x9: DATA + 4 }, mem: [[DATA + 3, [0x42]]] }, { regs: { x0: 0x42 } });
test("ldrsb unscaled", (a) => a.ldursb(0, 9, -3), { regs: { x9: DATA + 4 }, mem: [[DATA + 1, [0xff]]] }, { regs: { x0: u64(-1n) } });
test("ldursw", (a) => a.ldursw(0, 9, 4), { regs: { x9: DATA }, mem: [[DATA + 4, [0xff, 0xff, 0xff, 0xff]]] }, { regs: { x0: u64(-1n) } });
test("ldrReg w", (a) => a.ldrReg(4, 0, 9, 10), { regs: { x9: DATA, x10: 12 }, mem: [[DATA + 12, [1, 2, 3, 4]]] }, { regs: { x0: 0x04030201 } });
test("ldrReg x", (a) => a.ldrReg(8, 0, 9, 10), { regs: { x9: DATA, x10: 16 }, mem: [[DATA + 16, [1, 2, 3, 4, 5, 6, 7, 8]]] },
  { regs: { x0: 0x0807060504030201n } });
test("strReg w", (a) => a.strReg(4, 8, 9, 10), { regs: { x9: DATA, x10: 8, x8: 0x12345678 } }, { mem: [[DATA + 8, [0x78, 0x56, 0x34, 0x12]]] });
test("ldrsbReg", (a) => a.ldrsbReg(0, 9, 10), { regs: { x9: DATA, x10: 3 }, mem: [[DATA + 3, [0x80]]] }, { regs: { x0: u64(-128n) } });
test("ldrshReg", (a) => a.ldrshReg(0, 9, 10), { regs: { x9: DATA, x10: 2 }, mem: [[DATA + 2, [0x00, 0x80]]] }, { regs: { x0: u64(-32768n) } });
test("ldrswReg", (a) => a.ldrswReg(0, 9, 10), { regs: { x9: DATA, x10: 4 }, mem: [[DATA + 4, [0, 0, 0, 0x80]]] }, { regs: { x0: u64(-2147483648n) } });
test("ldp", (a) => a.ldp(0, 1, 9, 0), { regs: { x9: DATA }, mem: [[DATA, [1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]]] },
  { regs: { x0: 1, x1: 2 } });
test("stp", (a) => a.stp(8, 9, 10, 16), { regs: { x8: 0x11, x9: 0x22, x10: DATA } },
  { mem: [[DATA + 16, [0x11, 0, 0, 0, 0, 0, 0, 0]], [DATA + 24, [0x22, 0, 0, 0, 0, 0, 0, 0]]] });
test("stpPre/ldpPost", (a) => { a.stpPre(19, 20, 31, -16); a.ldpPost(19, 20, 31, 16); },
  { sp: DATA + 4096, regs: { x19: 0x11, x20: 0x22 } },
  { regs: { x19: 0x11, x20: 0x22 }, mem: [[DATA + 4096 - 16, [0x11, 0, 0, 0, 0, 0, 0, 0]], [DATA + 4096 - 8, [0x22, 0, 0, 0, 0, 0, 0, 0]]] });
test("ldr literal", (a) => {
  const k = a.fresh();
  const skip = a.fresh();
  a.ldrLit(0, k);
  a.b(skip);
  a.bind(k);
  a.bytes([0xef, 0xbe, 0xad, 0xde, 0xef, 0xbe, 0xad, 0xde]);
  a.bind(skip);
}, {}, { regs: { x0: 0xdeadbeefdeadbeefn } });
test("ldrw literal", (a) => {
  const k = a.fresh();
  const skip = a.fresh();
  a.ldrwLit(0, k);
  a.b(skip);
  a.bind(k);
  a.bytes([0x78, 0x56, 0x34, 0x12]);
  a.bind(skip);
}, {}, { regs: { x0: 0x12345678 } });

// ---- Floating point ---------------------------------------------------------------------------
for (const [x, y] of [[1.5, 2.25], [-3.5, 7.0], [0, -0], [1e300, -1e300], [Math.PI, Math.E]]) {
  const tag = `${x}/${y}`;
  test(`fadd ${tag}`, (a) => a.fadd(true, 0, 1, 2), { dregs: { d1: x, d2: y } }, { dregs: { d0: x + y } });
  test(`fsub ${tag}`, (a) => a.fsub(true, 0, 1, 2), { dregs: { d1: x, d2: y } }, { dregs: { d0: x - y } });
  test(`fmul ${tag}`, (a) => a.fmul(true, 0, 1, 2), { dregs: { d1: x, d2: y } }, { dregs: { d0: x * y } });
  test(`fdiv ${tag}`, (a) => a.fdiv(true, 0, 1, 2), { dregs: { d1: x, d2: y } }, { dregs: { d0: x / y } });
  test(`fmax ${tag}`, (a) => a.fmax(true, 0, 1, 2), { dregs: { d1: x, d2: y } }, { dregs: { d0: Math.max(x, y) } });
  test(`fmin ${tag}`, (a) => a.fmin(true, 0, 1, 2), { dregs: { d1: x, d2: y } }, { dregs: { d0: Math.min(x, y) } });
  if (x + y !== x + y) continue; // NaN results differ only in the sign bit between hosts
  test(`fadd32 ${tag}`, (a) => a.fadd(false, 0, 1, 2), { dregs: { d1: BigInt(bitsF32(x)), d2: BigInt(bitsF32(y)) } },
    { dregs: { d0: BigInt(bitsF32(Math.fround(Math.fround(x) + Math.fround(y)))) } });
}
test("fneg", (a) => a.fneg(true, 0, 1), { dregs: { d1: 3.25 } }, { dregs: { d0: -3.25 } });
test("fabs", (a) => a.fabs(true, 0, 1), { dregs: { d1: -3.25 } }, { dregs: { d0: 3.25 } });
test("fsqrt", (a) => a.fsqrt(true, 0, 1), { dregs: { d1: 9 } }, { dregs: { d0: 3 } });
test("frint m", (a) => a.frint(true, 0, 1, "m"), { dregs: { d1: -2.5 } }, { dregs: { d0: -3 } });
test("frint p", (a) => a.frint(true, 0, 1, "p"), { dregs: { d1: -2.5 } }, { dregs: { d0: -2 } });
test("frint z", (a) => a.frint(true, 0, 1, "z"), { dregs: { d1: 2.9 } }, { dregs: { d0: 2 } });
test("frint n", (a) => a.frint(true, 0, 1, "n"), { dregs: { d1: 2.5 } }, { dregs: { d0: 2 } });
test("frint a", (a) => a.frint(true, 0, 1, "a"), { dregs: { d1: 2.5 } }, { dregs: { d0: 3 } });
test("fcsel", (a) => { a.fcmp(true, 1, 2); a.fcsel(true, 0, 3, 4, Cond.LT); }, { dregs: { d1: 1, d2: 2, d3: 10, d4: 20 } },
  { dregs: { d0: 10 } });
test("fcsel gt", (a) => { a.fcmp(true, 1, 2); a.fcsel(true, 0, 3, 4, Cond.GT); }, { dregs: { d1: 3, d2: 2, d3: 10, d4: 20 } },
  { dregs: { d0: 10 } });
test("fcmp zero", (a) => { a.fcmpZero(true, 1); a.cset(0, Cond.EQ); }, { dregs: { d1: 0 } }, { regs: { x0: 1 } });
test("fcvt s->d", (a) => { a.fcvt(0, 1, true); }, { dregs: { d1: bitsF64(Math.fround(1.5)) } },
  { mem: [] });
test("scvtf i64->d", (a) => a.scvtf(true, true, false, 0, 1), { regs: { x1: u64(-7n) } }, { dregs: { d0: -7 } });
test("scvtf i64->d unsigned", (a) => a.scvtf(true, true, true, 0, 1), { regs: { x1: M } },
  { dregs: { d0: Number(M) } });
test("scvtf i32->d", (a) => a.scvtf(true, false, false, 0, 1), { regs: { x1: u64(-5n) } }, { dregs: { d0: -5 } });
test("fcvtzs d->i64", (a) => a.fcvtz(true, true, false, 0, 1), { dregs: { d1: -3.9 } }, { regs: { x0: u64(-3n) } });
test("fcvtzu d->i32", (a) => a.fcvtz(false, true, true, 0, 1), { dregs: { d1: 3.9 } }, { regs: { x0: 3 } });
test("fmov bits out", (a) => a.fmovToGpr(true, 0, 1), { dregs: { d1: 1.5 } }, { regs: { x0: bitsF64(1.5) } });
test("fmov bits in", (a) => a.fmovFromGpr(true, 0, 1), { regs: { x1: bitsF64(-2.75) } }, { dregs: { d0: -2.75 } });
test("fmov32 bits", (a) => a.fmovToGpr(false, 0, 1), { dregs: { d1: BigInt(bitsF32(1.5)) } },
  { regs: { x0: bitsF32(1.5) } });
test("fmov32 in", (a) => a.fmovFromGpr(false, 0, 1), { regs: { x1: bitsF32(-2.5) } },
  { dregs: { d0: BigInt(bitsF32(-2.5)) } });
test("fldrd", (a) => a.fldr(8, 0, 9, 8), { regs: { x9: DATA }, mem: [[DATA + 8, Buffer.from(new Float64Array([-12.5]).buffer)]] },
  { dregs: { d0: -12.5 } });
test("fstrd", (a) => a.fstr(8, 1, 9, 16), { regs: { x9: DATA }, dregs: { d1: 12.5 } },
  { mem: [[DATA + 16, Buffer.from(new Float64Array([12.5]).buffer)]] });
test("ldurd", (a) => a.ldurd(0, 9, -8), { regs: { x9: DATA + 64 }, mem: [[DATA + 56, Buffer.from(new Float64Array([7.5]).buffer)]] },
  { dregs: { d0: 7.5 } });
test("fldrReg", (a) => a.fldrReg(8, 0, 9, 10), { regs: { x9: DATA, x10: 24 }, mem: [[DATA + 24, Buffer.from(new Float64Array([3.5]).buffer)]] },
  { dregs: { d0: 3.5 } });
test("fstrReg", (a) => a.fstrReg(8, 1, 9, 10), { regs: { x9: DATA, x10: 32 }, dregs: { d1: -3.5 } },
  { mem: [[DATA + 32, Buffer.from(new Float64Array([-3.5]).buffer)]] });
test("fldrs/fstrs", (a) => { a.fstr(4, 1, 9, 0); a.fldr(4, 0, 9, 0); }, { regs: { x9: DATA }, dregs: { d1: BigInt(bitsF32(1.5)) } },
  { dregs: { d0: BigInt(bitsF32(1.5)) } });

// ---- Emit and run -----------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "enc-"));
const file = join(dir, "cases.json");
writeFileSync(file, JSON.stringify({ codeAddr: CODE, cases }));
try {
  const out = execFileSync("python3", [join(import.meta.dirname, "run-enc.py"), file], { encoding: "utf8" });
  process.stdout.write(out);
  if (!out.includes("ok:")) process.exit(1);
} catch (err) {
  process.stdout.write(err.stdout ?? "");
  process.stderr.write(err.stderr ?? "");
  process.exit(1);
}

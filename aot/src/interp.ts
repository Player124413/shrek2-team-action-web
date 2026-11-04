import type { BinOp, CpuField, Expr, IrFunc, IrBlock, Stmt, Term, Ty, UnOp } from "../../recomp/src/ir.ts";

/**
 * Reference interpreter for the recompiler IR.
 *
 * The ARM64 code generator (`arch-arm64.ts`) is verified by running the same IR functions two
 * ways — compiled and interpreted here — over random initial states and comparing the resulting
 * guest CPU state and memory. The semantics below are exactly what the WebAssembly backend emits
 * (`recomp/src/emit-wasm.ts`), which the project already validates against the real game.
 *
 * Values: every IR value is carried as a JS number (i32/f32 semantics) or bigint (i64), or a JS
 * number for f64 — the tag comes from the expression's declared type, not the JS value.
 */

export const CPU_OFFSET: Record<string, number> = {
  eax: 0, ecx: 4, edx: 8, ebx: 12, esp: 16, ebp: 20, esi: 24, edi: 28, eflags: 32, df: 36, fs_base: 40,
  ftop: 44, fcw: 48, fsw: 52, mxcsr: 56, fpr: 64, mm: 128, xmm: 192,
};
export const CPU_ELEM: Record<string, number> = { fpr: 8, mm: 8, xmm: 4 };
export const GPR = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"] as const;

export const RUNTIME_IMPORTS = [
  "rt_hle", "rt_dispatch", "rt_trap_id", "rt_cpuid", "rt_rep_movs", "rt_rep_stos", "rt_rcl", "rt_rcr",
  "rt_f80_load", "rt_f80_store", "rt_fist16", "rt_fist32", "rt_fist64", "rt_frndint", "rt_fxam", "rt_sin",
  "rt_cos", "rt_tan", "rt_atan2", "rt_log2", "rt_f2xm1", "rt_fscale", "rt_fprem", "rt_fprem1", "rt_fnsave",
  "rt_fnstenv", "rt_frstor", "rt_fldenv",
] as const;

export type Val = number | bigint;
const I32 = (v: Val) => Number(v) | 0;
const U32 = (v: Val) => Number(v) >>> 0;
const I64 = (v: Val) => BigInt.asIntN(64, BigInt(v as bigint));
const U64 = (v: Val) => BigInt.asUintN(64, BigInt(v as bigint));

const f64bits = (v: number) => new DataView(new Float64Array([v]).buffer).getBigUint64(0, true);
const bitsf64 = (b: Val) => new Float64Array(new BigUint64Array([U64(b)]).buffer)[0];
const f32bits = (v: number) => new DataView(new Float32Array([v]).buffer).getUint32(0, true);
const bitsf32 = (b: Val) => new Float32Array(new Uint32Array([U32(b)]).buffer)[0];

/** Host services the interpreter needs from the test harness. */
export interface Host {
  /** Guest memory window (index 0 == guest address 0). */
  mem: Uint8Array;
  /** Runtime helper with the runtime's signature; returns the result as a Val. */
  helper(name: string, args: Val[]): Val;
  /** `rt_hle(cpu, slot)`: the HLE callee, which may change the CPU and memory. */
  hle(slot: number, name: string): void;
  /** `rt_dispatch(cpu, target)`: call another guest function and interpret it. */
  callGuest(target: number): void;
  /** `rt_trap_id(cpu, id)`: throws in the harness. */
  trap(id: number): never;
  /**
   * Optional recorder for helper calls: receives the memory image before and after the call so a
   * machine-code harness can reproduce the same effect without reimplementing the helper.
   */
  record?(name: string, before: Uint8Array | null, after: Uint8Array | null, result: Val | null): void;
}

export class Machine {
  readonly view: DataView;
  readonly host: Host;
  nodes = 0;
  maxNodes = 5_000_000;
  /** Optional per-block trace (block id strings), used by the differential harness when debugging. */
  traceBlocks: string[] | null = null;

  constructor(host: Host) {
    this.host = host;
    this.view = new DataView(host.mem.buffer, host.mem.byteOffset, host.mem.byteLength);
  }

  ld32(off: number) { return this.view.getUint32(off, true); }
  ld64(off: number) { return this.view.getBigUint64(off, true); }
  ld8(off: number) { return this.view.getUint8(off); }
  ld16(off: number) { return this.view.getUint16(off, true); }

  cpuU32(c: number, field: string, index?: Val): number {
    const off = c + CPU_OFFSET[field] + (index === undefined ? 0 : Number(index) * (CPU_ELEM[field] ?? 1));
    return this.view.getUint32(off, true);
  }

  cpuSetU32(c: number, field: string, value: Val, index?: Val): void {
    const off = c + CPU_OFFSET[field] + (index === undefined ? 0 : Number(index) * (CPU_ELEM[field] ?? 1));
    this.view.setUint32(off, U32(value), true);
  }

  cpuSetF64(c: number, field: string, value: Val, index?: Val): void {
    const off = c + CPU_OFFSET[field] + (index === undefined ? 0 : Number(index) * (CPU_ELEM[field] ?? 1));
    this.view.setFloat64(off, Number(value), true);
  }

  cpuSet64(c: number, field: string, value: Val, index?: Val): void {
    const off = c + CPU_OFFSET[field] + (index === undefined ? 0 : Number(index) * (CPU_ELEM[field] ?? 1));
    this.view.setBigUint64(off, U64(value), true);
  }
}

export type Val_ = Val;

// ---------------------------------------------------------------------------------------------
// Expression evaluation (mirrors recomp/src/emit-wasm.ts)

export function evalExpr(m: Machine, c: number, e: Expr, l: Map<string, Val>): Val {
  if (++m.nodes > m.maxNodes) throw new Error("interpreter step limit exceeded");
  switch (e.k) {
    case "const": {
      const v = e.v;
      if (e.ty === "i64") return U64(BigInt(v as bigint));
      if (e.ty === "f32") return Math.fround(Number(v));
      if (e.ty === "f64") return Number(v);
      return I32(Number(v));
    }
    case "local": {
      const v = l.get(e.name);
      if (v === undefined) throw new Error(`unbound local ${e.name}`);
      return v;
    }
    case "load": {
      const addr = U32(evalExpr(m, c, e.addr, l));
      if (e.ty === "i64") return m.ld64(addr);
      if (e.ty === "f32") return bitsf32(m.ld32(addr));
      if (e.ty === "f64") return bitsf64(m.ld64(addr));
      if (e.bytes === 1) return e.signed ? (m.ld8(addr) << 24) >> 24 : m.ld8(addr);
      if (e.bytes === 2) return e.signed ? (m.ld16(addr) << 16) >> 16 : m.ld16(addr);
      return I32(m.ld32(addr));
    }
    case "cpu": {
      const index = e.index ? evalExpr(m, c, e.index, l) : undefined;
      if (e.field === "fpr") return m.view.getFloat64(c + CPU_OFFSET.fpr + Number(index) * 8, true);
      if (e.field === "mm") return m.view.getBigUint64(c + CPU_OFFSET.mm + Number(index) * 8, true);
      return m.cpuU32(c, e.field, index);
    }
    case "un": return evalUn(m, c, e, l);
    case "bin": return evalBin(m, c, e, l);
    case "select": {
      // Operand order and eagerness follow the WebAssembly backend: both arms are evaluated (and
      // therefore both arms' helper calls happen) before the condition is consumed.
      const a = evalExpr(m, c, e.a, l);
      const b = evalExpr(m, c, e.b, l);
      const cond = evalExpr(m, c, e.c, l);
      // The condition is an i32 in WebAssembly; keep the same rule here.
      return I32(cond) !== 0 ? a : b;
    }
    case "call": return callPure(m, c, e, l);
    default:
      throw new Error(`bad expression ${(e as { k: string }).k}`);
  }
}

function evalUn(m: Machine, c: number, e: Expr & { k: "un" }, l: Map<string, Val>): Val {
  const a = evalExpr(m, c, e.a, l);
  const f64 = e.ty === "f64";
  const f32 = e.ty === "f32";
  switch (e.op) {
    case "neg": return e.ty === "i64" ? U64(-I64(a)) : I32(-I32(a));
    case "not": return e.ty === "i64" ? U64(~U64(a)) : I32(~I32(a));
    case "eqz": return (e.ty === "i64" ? U64(a) === 0n : I32(a) === 0) ? 1 : 0;
    case "clz": {
      const v = U32(a);
      return v === 0 ? 32 : Math.clz32(v);
    }
    case "ctz": {
      const v = U32(a);
      return v === 0 ? 32 : 31 - Math.clz32(v & -v);
    }
    case "popcnt": {
      let v = U32(a), n = 0;
      while (v) { n += v & 1; v >>>= 1; }
      return n;
    }
    case "ext8s": return (I32(a) << 24) >> 24;
    case "ext16s": return (I32(a) << 16) >> 16;
    case "bswap": {
      const v = U32(a);
      return I32(((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24));
    }
    case "wrap": return I32(a);
    case "extu": return U64(a);
    case "exts": return I64(a);
    case "f32to64": return a as number;
    case "f64to32": return Math.fround(a as number);
    case "i32tof64s": return I32(a);
    case "i32tof64u": return U32(a);
    case "i64tof64s": return Number(I64(a));
    case "i32tof32s": return Math.fround(I32(a));
    case "f64toi32sat": {
      const x = a as number;
      if (x !== x) return 0;
      if (x >= 2147483647) return 0x7fffffff;
      if (x <= -2147483648) return -2147483648;
      return Math.trunc(x);
    }
    case "bitsf32": return bitsf32(a);
    case "f32bits": return f32bits(a as number);
    case "bitsf64": return f64bits(a as number);
    case "f64bits": return bitsf64(a);
    case "fneg": return f32 ? Math.fround(-(a as number)) : -(a as number);
    case "fabs": return f32 ? Math.fround(Math.abs(a as number)) : Math.abs(a as number);
    case "fsqrt": return f32 ? Math.fround(Math.sqrt(a as number)) : Math.sqrt(a as number);
    case "fceil": return Math.ceil(a as number);
    case "ffloor": return Math.floor(a as number);
    case "ftrunc": return Math.trunc(a as number);
    case "fnearest": {
      const x = f32 ? Math.fround(a as number) : (a as number);
      const t = Math.trunc(x);
      if (Math.abs(x - t) !== 0.5) return t;
      const lower = Math.floor(x);
      return lower % 2 === 0 ? lower : lower + 1;
    }
    case "f64to32": return Math.fround(a as number);
    default:
      void f64;
      throw new Error(`bad unary ${e.op}`);
  }
}

function evalBin(m: Machine, c: number, e: Expr & { k: "bin" }, l: Map<string, Val>): Val {
  // Operand evaluation order follows the WebAssembly backend, which pushes the right operand first
  // (the stack machine's `binary` helper pops `b`, then `a`). It only shows up when an operand calls
  // a runtime helper, but then it decides the order of those calls and their side effects.
  const b = evalExpr(m, c, e.b, l);
  const a = evalExpr(m, c, e.a, l);
  const ty = e.ty;
  const op = e.op;
  const cmp = (cond: boolean) => (cond ? 1 : 0);

  // Float comparisons and arithmetic (ty is the result type for comparisons, so look at operands).
  const f32op = e.a.ty === "f32";
  const fOp = /^f(add|sub|mul|div|min|max|eq|ne|lt|le|gt|ge)$/.exec(op);
  if (fOp) {
    const x = f32op ? Math.fround(a as number) : (a as number);
    const y = f32op ? Math.fround(b as number) : (b as number);
    const r = (v: number) => (f32op ? Math.fround(v) : v);
    switch (fOp[1]) {
      case "add": return r(x + y);
      case "sub": return r(x - y);
      case "mul": return r(x * y);
      case "div": return r(x / y);
      case "min":
        if (x !== x || y !== y) return NaN;
        if (x === 0 && y === 0) return Object.is(x, -0) || Object.is(y, -0) ? -0 : 0;
        return Math.min(x, y);
      case "max":
        if (x !== x || y !== y) return NaN;
        if (x === 0 && y === 0) return Object.is(x, -0) && Object.is(y, -0) ? -0 : 0;
        return Math.max(x, y);
      case "eq": return cmp(x === y);
      case "ne": return cmp(x !== y);
      case "lt": return cmp(x < y);
      case "le": return cmp(x <= y);
      case "gt": return cmp(x > y);
      case "ge": return cmp(x >= y);
    }
  }

  if (ty === "i64") {
    const x = U64(a), y = U64(b), sx = I64(a), sy = I64(b);
    const s = y & 63n;
    switch (op) {
      case "add": return U64(x + y);
      case "sub": return U64(x - y);
      case "mul": return U64(x * y);
      case "and": return x & y;
      case "or": return x | y;
      case "xor": return x ^ y;
      case "shl": return U64(x << s);
      case "shru": return U64(x >> s);
      case "shrs": return U64(sx >> s);
      case "rotl": return s === 0n ? x : U64((x << s) | (x >> (64n - s)));
      case "rotr": return s === 0n ? x : U64((x >> s) | (x << (64n - s)));
      case "divs": return y === 0n ? 0n : y === U64(-1n) ? U64(-sx) : U64(sx / sy);
      case "divu": return y === 0n ? 0n : x / y;
      case "rems": return y === 0n ? 0n : y === U64(-1n) ? 0n : U64(sx % sy);
      case "remu": return y === 0n ? 0n : x % y;
      case "eq": return cmp(x === y);
      case "ne": return cmp(x !== y);
      case "lts": return cmp(sx < sy);
      case "ltu": return cmp(x < y);
      case "les": return cmp(sx <= sy);
      case "leu": return cmp(x <= y);
      case "gts": return cmp(sx > sy);
      case "gtu": return cmp(x > y);
      case "ges": return cmp(sx >= sy);
      case "geu": return cmp(x >= y);
      default: throw new Error(`bad i64 binop ${op}`);
    }
  }

  const x = I32(a), y = I32(b), ux = U32(a), uy = U32(b);
  const s = uy & 31;
  switch (op) {
    case "add": return I32(x + y);
    case "sub": return I32(x - y);
    case "mul": return Math.imul(x, y);
    case "and": return x & y;
    case "or": return x | y;
    case "xor": return x ^ y;
    case "shl": return I32(ux << s);
    case "shru": return I32(ux >>> s);
    case "shrs": return x >> s;
    case "rotl": return I32((ux << s) | (ux >>> ((32 - s) & 31)));
    case "rotr": return I32((ux >>> s) | (ux << ((32 - s) & 31)));
    case "divs": return y === 0 ? 0 : y === -1 ? I32(-x) : I32(Math.trunc(x / y));
    case "divu": return uy === 0 ? 0 : I32(Math.floor(ux / uy));
    case "rems": return y === 0 ? 0 : y === -1 ? 0 : I32(x % y);
    case "remu": return uy === 0 ? 0 : I32(ux % uy);
    case "eq": return cmp(x === y);
    case "ne": return cmp(x !== y);
    case "lts": return cmp(x < y);
    case "ltu": return cmp(ux < uy);
    case "les": return cmp(x <= y);
    case "leu": return cmp(ux <= uy);
    case "gts": return cmp(x > y);
    case "gtu": return cmp(ux > uy);
    case "ges": return cmp(x >= y);
    case "geu": return cmp(ux >= uy);
    default: throw new Error(`bad i32 binop ${op}`);
  }
}

/** Helpers that read or write guest memory, and therefore need a before/after snapshot. */
const MEMORY_HELPERS = new Set(["rt_f80_load", "rt_f80_store", "rt_rep_movs", "rt_rep_stos"]);

/** Pure helper calls (`call` expressions); implemented by the C++ runtime on device. */
function callPure(m: Machine, c: number, e: Expr & { k: "call" }, l: Map<string, Val>): Val {
  if (!m.host.record) return callPureInner(m, c, e, l);
  // Recording run: report the before/after memory image and the result so a machine-code harness
  // can reproduce the very same effect instead of reimplementing the helper. Only the helpers that
  // touch guest memory are snapshotted; copying the image for every arithmetic helper would make
  // the recording run quadratically slow.
  if (!MEMORY_HELPERS.has(e.fn)) {
    const value = callPureInner(m, c, e, l);
    m.host.record(e.fn, null, null, value);
    return value;
  }
  const before = new Uint8Array(m.host.mem);
  const value = callPureInner(m, c, e, l);
  m.host.record(e.fn, before, new Uint8Array(m.host.mem), value);
  return value;
}

function callPureInner(m: Machine, c: number, e: Expr & { k: "call" }, l: Map<string, Val>): Val {
  const args = e.args.map((a) => evalExpr(m, c, a, l));
  const num = (i: number) => Number(args[i]);
  switch (e.fn) {
    case "parity8": {
      let v = num(0) & 0xff;
      v ^= v >> 4; v ^= v >> 2; v ^= v >> 1;
      return 1 - (v & 1);
    }
    case "rt_round24": {
      const x = num(0);
      const t = x * 536870913;
      const r = t - (t - x);
      return r === r && t - t === 0 ? r : x;
    }
    case "rt_f80_load": return m.view.getFloat64(U32(args[0]), true);
    case "rt_fist16": return fist(num(0), num(1), 16);
    case "rt_fist32": return fist(num(0), num(1), 32);
    case "rt_fist64": return BigInt.asUintN(64, BigInt(fist(num(0), num(1), 64)));
    case "rt_frndint": return frndint(num(0), num(1));
    case "rt_fxam": {
      const bits = f64bits(num(0));
      const sign = Number((bits >> 63n) & 1n) << 3;
      const exp = Number((bits >> 52n) & 0x7ffn);
      const frac = bits & 0xfffffffffffffn;
      if (exp === 0 && frac === 0n) return sign | 0b0100;
      if (exp === 0x7ff) return sign | 0b0101;
      if (exp === 0) return sign | 0b0110;
      return sign;
    }
    case "rt_sin": return Math.sin(num(0));
    case "rt_cos": return Math.cos(num(0));
    case "rt_tan": return Math.tan(num(0));
    case "rt_atan2": return Math.atan2(num(0), num(1));
    case "rt_log2": return Math.log2(num(0));
    case "rt_f2xm1": return Math.pow(2, num(0)) - 1;
    case "rt_fscale": return num(0) * Math.pow(2, Math.trunc(num(1)));
    default:
      return m.host.helper(e.fn, args);
  }
}

/** x87 integer store: rounding per the control word, indefinite on overflow. */
function fist(v: number, fcw: number, bits: number): number {
  let r: number;
  const rc = (fcw >> 10) & 3;
  if (rc === 0) {
    const t = Math.trunc(v);
    if (Math.abs(v - t) !== 0.5) r = t;
    else {
      const lower = Math.floor(v);
      r = lower % 2 === 0 ? lower : lower + 1;
    }
  } else if (rc === 1) r = Math.floor(v);
  else if (rc === 2) r = Math.ceil(v);
  else r = Math.trunc(v);
  if (r !== r) return bits === 16 ? -32768 : bits === 32 ? -2147483648 : 0;
  if (bits === 16) return r < -32768 || r > 32767 ? -32768 : r;
  if (bits === 32) return r < -2147483648 || r > 2147483647 ? -2147483648 : r;
  return r;
}

function frndint(v: number, fcw: number): number {
  const rc = (fcw >> 10) & 3;
  if (rc === 1) return Math.floor(v);
  if (rc === 2) return Math.ceil(v);
  if (rc === 3) return Math.trunc(v);
  const t = Math.trunc(v);
  if (Math.abs(v - t) !== 0.5) return t;
  const lower = Math.floor(v);
  return lower % 2 === 0 ? lower : lower + 1;
}

export { I32, U32, I64, U64, f64bits, bitsf64, f32bits, bitsf32 };

/** Execute one IR function starting at its entry block; returns EAX. */
export function runFunction(m: Machine, c: number, f: IrFunc, depth = 0): number {
  if (depth > 64) throw new Error("call depth exceeded");
  const l = new Map<string, Val>();
  for (const g of GPR) l.set(g, m.cpuU32(c, g));
  l.set("ftop", m.cpuU32(c, "ftop"));
  l.set("df", m.cpuU32(c, "df"));
  for (const [name, ty] of f.locals) if (!l.has(name)) l.set(name, ty === "i64" ? 0n : ty === "f64" ? 0 : 0);
  let id = f.order[0];
  for (let steps = 0; ; steps++) {
    if (steps > 100000) throw new Error("basic-block limit exceeded");
    m.traceBlocks?.push(id);
    const block = f.blocks.get(id);
    if (!block) throw new Error(`missing block ${id}`);
    for (const st of block.stmts) execStmt(m, c, st, l);
    const t = block.term;
    switch (t.k) {
      case "br": id = t.to; continue;
      case "cbr": id = I32(evalExpr(m, c, t.c, l)) !== 0 ? t.t : t.f; continue;
      case "switch": {
        const v = I32(evalExpr(m, c, t.idx, l));
        id = v >= 0 && v < t.targets.length ? t.targets[v] : t.dflt;
        continue;
      }
      case "switchaddr": {
        const v = U32(evalExpr(m, c, t.target, l));
        let found: string | undefined;
        for (const [addr, target] of t.cases) if (addr === v) { found = target; break; }
        id = found ?? t.dflt;
        continue;
      }
      case "ret": return m.cpuU32(c, "eax");
      case "tail": m.host.callGuest(t.target); return m.cpuU32(c, "eax");
      case "tailind": m.host.callGuest(U32(evalExpr(m, c, t.target, l))); return m.cpuU32(c, "eax");
      case "tailhle":
        syncOut(m, c, l);
        m.host.hle(t.slot, t.name);
        return m.cpuU32(c, "eax");
      case "trap": return m.host.trap(-1);
      default: throw new Error(`bad terminator ${(t as { k: string }).k}`);
    }
  }
}

function syncOut(m: Machine, c: number, l: Map<string, Val>): void {
  for (const g of GPR) m.cpuSetU32(c, g, l.get(g) as Val);
  m.cpuSetU32(c, "ftop", l.get("ftop") as Val);
  m.cpuSetU32(c, "df", l.get("df") as Val);
}

function syncIn(m: Machine, c: number, l: Map<string, Val>): void {
  for (const g of GPR) l.set(g, m.cpuU32(c, g));
  l.set("ftop", m.cpuU32(c, "ftop"));
  l.set("df", m.cpuU32(c, "df"));
}

function execStmt(m: Machine, c: number, s: Stmt, l: Map<string, Val>): void {
  switch (s.k) {
    case "set":
      l.set(s.name, evalExpr(m, c, s.v, l));
      return;
    case "store": {
      const addr = U32(evalExpr(m, c, s.addr, l));
      const v = evalExpr(m, c, s.v, l);
      const ty = s.v.ty;
      if (ty === "i64") m.view.setBigUint64(addr, U64(v), true);
      else if (ty === "f64") m.view.setFloat64(addr, v as number, true);
      else if (ty === "f32") m.view.setFloat32(addr, v as number, true);
      else if (s.bytes === 4) m.view.setUint32(addr, U32(v), true);
      else if (s.bytes === 2) m.view.setUint16(addr, U32(v) & 0xffff, true);
      else m.view.setUint8(addr, U32(v) & 0xff);
      return;
    }
    case "cpuset": {
      const index = s.index ? evalExpr(m, c, s.index, l) : undefined;
      const v = evalExpr(m, c, s.v, l);
      if (s.v.ty === "f64") m.cpuSetF64(c, s.field, v, index);
      else if (s.v.ty === "i64") m.cpuSet64(c, s.field, v, index);
      else m.cpuSetU32(c, s.field, v, index);
      return;
    }
    case "syncout": syncOut(m, c, l); return;
    case "syncin": syncIn(m, c, l); return;
    case "callguest":
      syncOut(m, c, l);
      m.host.callGuest(s.target);
      syncIn(m, c, l);
      return;
    case "callind":
      syncOut(m, c, l);
      m.host.callGuest(U32(evalExpr(m, c, s.target, l)));
      syncIn(m, c, l);
      return;
    case "callhle":
      syncOut(m, c, l);
      m.host.hle(s.slot, s.name);
      syncIn(m, c, l);
      return;
    case "helper": {
      // Side-effecting runtime helper: like the HLE path, it sees the published registers and may
      // change the whole Cpu struct, so the state in both directions goes through the struct.
      const args = s.args.map((a) => evalExpr(m, c, a, l));
      const before = m.host.record ? new Uint8Array(m.host.mem) : null;
      syncOut(m, c, l);
      sideEffect(m, c, s.fn, args);
      syncIn(m, c, l);
      if (before && m.host.record) m.host.record(s.fn, before, new Uint8Array(m.host.mem), null);
      return;
    }
    case "trap": m.host.trap(-1); return;
    case "check":
      if (I32(evalExpr(m, c, s.c, l)) === 0) m.host.trap(-1);
      return;
    case "comment":
      return;
    default:
      throw new Error(`bad statement ${(s as { k: string }).k}`);
  }
}

/** Side-effecting helpers (they take the Cpu pointer first). */
function sideEffect(m: Machine, c: number, name: string, args: (number | bigint)[]): void {
  switch (name) {
    case "rt_cpuid":
      m.cpuSetU32(c, "eax", 0x634);
      m.cpuSetU32(c, "ebx", 0x383);
      return;
    case "rt_f80_store": {
      const addr = U32(args[0]);
      m.view.setBigUint64(addr, f64bits(Number(args[1])), true);
      m.view.setUint16(addr + 8, 0x3fff, true);
      return;
    }
    case "rt_rep_movs": {
      const size = U32(args[0]);
      const df = U32(args[1]);
      let src = m.cpuU32(c, "esi"), dst = m.cpuU32(c, "edi"), count = m.cpuU32(c, "ecx");
      const step = df ? -size : size;
      for (let i = 0; i < count; i++, src = (src + step) >>> 0, dst = (dst + step) >>> 0) {
        for (let b = 0; b < size; b++) m.view.setUint8((dst + b) >>> 0, m.view.getUint8((src + b) >>> 0));
      }
      m.cpuSetU32(c, "esi", src);
      m.cpuSetU32(c, "edi", dst);
      m.cpuSetU32(c, "ecx", 0);
      return;
    }
    case "rt_rep_stos": {
      const size = U32(args[0]);
      const df = U32(args[1]);
      let dst = m.cpuU32(c, "edi"), count = m.cpuU32(c, "ecx");
      const ax = U32(m.cpuU32(c, "eax"));
      const step = df ? -size : size;
      for (let i = 0; i < count; i++, dst = (dst + step) >>> 0) {
        for (let b = 0; b < size; b++) m.view.setUint8((dst + b) >>> 0, size === 1 ? ax & 0xff : (ax >> (b * 8)) & 0xff);
      }
      m.cpuSetU32(c, "edi", dst);
      m.cpuSetU32(c, "ecx", 0);
      return;
    }
    default:
      throw new Error(`side-effecting helper ${name} not modelled by the reference interpreter`);
  }
}

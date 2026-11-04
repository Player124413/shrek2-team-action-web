/**
 * IR optimisation passes, run between the front end and the ARM64 emitter.
 *
 * The emitter already folds immediates into instructions (`canFoldConst`), reuses pinned registers and
 * keeps the x87 stack in registers, but it emits what the lifter produced: three things in that IR
 * cost real instructions on every x86 instruction the game executes, and each has an exact, verified
 * counterpart here:
 *
 * 1. **Dead flag updates.** The lifter writes `cf/pf/af/zf/sf/of` after every arithmetic instruction.
 *    Almost all of those writes are dead: the next consumer is a conditional jump far away, and the
 *    next flag-producing instruction overwrites them first. Removing the stores also lets the emitter
 *    drop the four-instruction carry/parity/overflow computation that feeds them (the expression is
 *    evaluated in place, so a dead store is exactly the cost of the sequence behind it).
 * 2. **Constant folding.** `0x401000 + 8`-style address arithmetic is everywhere in the lifted code;
 *    the emitter still materialises both operands and emits the operation.
 * 3. **Redundant syncs.** `syncout`/`syncin` bracketing a call publish and reload the whole guest
 *    register file. Adjacent pairs (a call that was folded away, or a helper that only reads) publish
 *    and immediately reload the same values, so they are pure overhead.
 *
 * Every pass is conservative: an instruction whose effect it cannot see (a call, a store to guest
 * memory, an unknown helper) ends the lifetime of everything it cannot prove. The differential test
 * (`aot/test/opt.test.mjs`) runs the optimised functions against the reference interpreter exactly as
 * `arch.test.mjs` does for unoptimised ones, so a pass that is wrong in a corner shows up as a state
 * mismatch rather than as a game bug on a phone.
 */
import type { Expr, IrBlock, IrFunc, Stmt, Term } from "../../recomp/src/ir.ts";

/** The x86 flags, as local names in the lifted IR (`aot/src/arch-arm64.ts` pins them). */
export const FLAGS = ["cf", "pf", "af", "zf", "sf", "of"] as const;
const FLAG_SET = new Set<string>(FLAGS);

/** Locals whose values live in the `Cpu` struct and therefore survive a call unchanged in name only. */
function isGuestReg(name: string): boolean {
  return /^(eax|ecx|edx|ebx|esp|ebp|esi|edi|ftop|df)$/.test(name);
}

// ---------------------------------------------------------------------------------------------
// Expression traversal

/** Calls `f` on every sub-expression of `e` (pre-order). */
export function walkExpr(e: Expr, f: (e: Expr) => void): void {
  f(e);
  const any = e as unknown as Record<string, unknown>;
  switch (e.k) {
    case "bin":
      walkExpr(e.a, f);
      walkExpr(e.b, f);
      return;
    case "un":
      walkExpr(e.a, f);
      return;
    case "select":
      walkExpr(e.c, f);
      walkExpr(e.a, f);
      walkExpr(e.b, f);
      return;
    case "load":
    case "storedelta":
      walkExpr(e.addr, f);
      return;
    case "call":
      for (const a of e.args) walkExpr(a, f);
      return;
    case "cpu":
      if (e.index) walkExpr(e.index, f);
      return;
    default:
      // const / local / cpu (no index): nothing below.
      void any;
  }
}

/** Maps every sub-expression bottom-up; the callback returns a replacement or the same node. */
export function mapExpr(e: Expr, f: (e: Expr) => Expr): Expr {
  const m = (x: Expr): Expr => mapExpr(x, f);
  let out: Expr = e;
  switch (e.k) {
    case "bin":
      out = { ...e, a: m(e.a), b: m(e.b) };
      break;
    case "un":
      out = { ...e, a: m(e.a) };
      break;
    case "select":
      out = { ...e, c: m(e.c), a: m(e.a), b: m(e.b) };
      break;
    case "load":
    case "storedelta":
      out = { ...e, addr: m(e.addr) };
      break;
    case "call":
      out = { ...e, args: e.args.map(m) };
      break;
    case "cpu":
      out = e.index ? { ...e, index: m(e.index) } : e;
      break;
    default:
      break;
  }
  return f(out);
}

/** True when `name` is read anywhere in `e`. */
export function readsLocal(e: Expr, name: string): boolean {
  let found = false;
  walkExpr(e, (x) => {
    if (x.k === "local" && x.name === name) found = true;
  });
  return found;
}

/** True when `e` contains a call or a load: an expression with side effects or a memory dependency. */
export function hasEffect(e: Expr): boolean {
  let found = false;
  walkExpr(e, (x) => {
    if (x.k === "call" || x.k === "load" || x.k === "storedelta") found = true;
  });
  return found;
}

// ---------------------------------------------------------------------------------------------
// Pass 1: constant folding

/** The integer value of a constant expression, or undefined when it is not one. */
function constValue(e: Expr): { v: number; ty: "i32" | "i64" } | undefined {
  if (e.k === "const") {
    const c = e as Expr & { k: "const" };
    if (typeof c.v === "bigint") {
      if (BigInt.asIntN(64, c.v) < BigInt(Number.MIN_SAFE_INTEGER) || BigInt.asIntN(64, c.v) > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      return { v: Number(BigInt.asIntN(32, c.v)), ty: "i32" };
    }
    return { v: c.v | 0, ty: c.ty === "i64" ? "i64" : "i32" };
  }
  if (e.k === "un" && e.op === "not" && e.a.k === "const") {
    const a = constValue(e.a);
    if (a) return { v: ~a.v | 0, ty: "i32" };
  }
  if (e.k === "bin") {
    const a = constValue(e.a);
    const b = constValue(e.b);
    if (!a || !b) return undefined;
    const v = fold(a.v, b.v, e.op);
    if (v === undefined) return undefined;
    // A comparison yields 0/1 regardless of the operand width.
    const cmp = ["eq", "ne", "lts", "ltu", "les", "leu", "gts", "gtu", "ges", "geu"].includes(e.op);
    return { v: v | 0, ty: cmp ? "i32" : a.ty };
  }
  return undefined;
}

function fold(a: number, b: number, op: string): number | undefined {
  switch (op) {
    case "add": return (a + b) | 0;
    case "sub": return (a - b) | 0;
    case "mul": return Math.imul(a, b);
    case "and": return a & b;
    case "or": return a | b;
    case "xor": return a ^ b;
    case "shl": return (a << (b & 31)) | 0;
    case "shru": return (a >>> (b & 31)) | 0;
    case "shrs": return (a >> (b & 31)) | 0;
    case "rotl": return ((a << (b & 31)) | (a >>> ((32 - (b & 31)) & 31))) | 0;
    case "rotr": return ((a >>> (b & 31)) | (a << ((32 - (b & 31)) & 31))) | 0;
    case "eq": return a === b ? 1 : 0;
    case "ne": return a !== b ? 1 : 0;
    case "lts": return a < b ? 1 : 0;
    case "ltu": return (a >>> 0) < (b >>> 0) ? 1 : 0;
    case "les": return a <= b ? 1 : 0;
    case "leu": return (a >>> 0) <= (b >>> 0) ? 1 : 0;
    case "gts": return a > b ? 1 : 0;
    case "gtu": return (a >>> 0) > (b >>> 0) ? 1 : 0;
    case "ges": return a >= b ? 1 : 0;
    case "geu": return (a >>> 0) >= (b >>> 0) ? 1 : 0;
    default: return undefined;
  }
}

/**
 * Fold constant sub-expressions and absorb the identities the lifter produces constantly:
 * `x + 0`, `x ^ 0`, `x & -1`, `x | 0`, `x * 1`, shifts by zero, and a select with constant arms.
 *
 * Only integer expressions are folded here; floating point is left alone (a host x87 emulation may
 * not round identically, and the emitter's FP path is already a single instruction per operation).
 */
export function foldConstants(f: IrFunc): { functions: IrFunc; folded: number } {
  let folded = 0;
  const fix = (e: Expr): Expr => {
    const c = constValue(e);
    if (c) {
      folded++;
      return { k: "const", ty: c.ty, v: c.ty === "i64" ? BigInt(c.v) : c.v } as Expr;
    }
    if (e.k !== "bin") {
      if (e.k === "select" && e.c.k === "const") {
        folded++;
        return ((e.c as Expr & { v: number }).v | 0) !== 0 ? e.a : e.b;
      }
      if (e.k === "select" && e.a.k === "const" && e.b.k === "const" && (e.a as { v: number }).v === (e.b as { v: number }).v) {
        folded++;
        return e.a;
      }
      return e;
    }
    const rhs = e.b.k === "const" ? ((e.b as Expr & { v: number }).v | 0) : undefined;
    if (rhs !== undefined) {
      switch (e.op) {
        case "add":
        case "sub":
        case "or":
        case "xor":
          if (rhs === 0) { folded++; return e.a; }
          break;
        case "and":
          if (rhs === -1) { folded++; return e.a; }
          if (rhs === 0) { folded++; return { k: "const", ty: "i32", v: 0 } as Expr; }
          break;
        case "mul":
          if (rhs === 1) { folded++; return e.a; }
          if (rhs === 0) { folded++; return { k: "const", ty: "i32", v: 0 } as Expr; }
          break;
        case "shl":
        case "shru":
        case "shrs":
          if ((rhs & 31) === 0) { folded++; return e.a; }
          break;
        default:
          break;
      }
    }
    return e;
  };
  const blocks = new Map<string, IrBlock>();
  for (const [id, b] of f.blocks) {
    blocks.set(id, {
      id,
      stmts: b.stmts.map((s) => mapStmtExprs(s, fix)),
      term: mapTermExprs(b.term, fix),
    });
  }
  return { functions: { ...f, blocks }, folded };
}

function mapStmtExprs(s: Stmt, f: (e: Expr) => Expr): Stmt {
  switch (s.k) {
    case "set": return { ...s, v: mapExpr(s.v, f) };
    case "store": return { ...s, addr: mapExpr(s.addr, f), v: mapExpr(s.v, f) };
    case "cpuset": return { ...s, index: s.index ? mapExpr(s.index, f) : undefined, v: mapExpr(s.v, f) };
    case "callind": return { ...s, target: mapExpr(s.target, f) };
    case "helper": return { ...s, args: s.args.map((a) => mapExpr(a, f)) };
    case "check": return { ...s, c: mapExpr(s.c, f) };
    default: return s;
  }
}

function mapTermExprs(t: Term, f: (e: Expr) => Expr): Term {
  switch (t.k) {
    case "cbr": return { ...t, c: mapExpr(t.c, f) };
    case "switch": return { ...t, idx: mapExpr(t.idx, f) };
    case "switchaddr": return { ...t, target: mapExpr(t.target, f) };
    case "tailind": return { ...t, target: mapExpr(t.target, f) };
    default: return t;
  }
}

// ---------------------------------------------------------------------------------------------
// Pass 2: dead flag stores

/** Every local read by an expression (writes excluded). */
function collectReads(e: Expr, out: Set<string>): void {
  walkExpr(e, (x) => {
    if (x.k === "local") out.add(x.name);
  });
}

/**
 * Which flags can be observed at the end of each block.
 *
 * `liveOut[b]` is the union of `liveIn` over the block's successors; `liveIn[b]` is that plus every
 * flag `b` itself reads (its terminator's condition and, conservatively, any flag a statement reads
 * before the backward scan below can prove the read is dead). Over-approximating keeps a store that
 * might be dead -- which is safe -- while under-approximating deletes one that is live, which is what
 * this fixed point exists to prevent.
 *
 * A `syncout` publishes the whole register file to the Cpu struct and a call may read anything from
 * it, so both make every flag live at that point; that is handled in the backward scan, not here.
 */
export function removeDeadFlags(f: IrFunc): { functions: IrFunc; removed: number } {
  const liveOut = new Map<string, Set<string>>();
  for (const id of f.order) liveOut.set(id, new Set());

  const isWriteOfAnyFlag = (s: Stmt): boolean => s.k === "set" && (FLAG_SET.has(s.name) || s.name === "ftop");

  /** Flags read by a block's terminator. */
  const termFlagReads = (t: Term): Set<string> => {
    const out = new Set<string>();
    const ex = t.k === "cbr" ? t.c : t.k === "switch" ? t.idx : t.k === "switchaddr" || t.k === "tailind" ? t.target : undefined;
    if (ex) {
      const reads = new Set<string>();
      collectReads(ex, reads);
      for (const r of reads) if (FLAG_SET.has(r) || r === "ftop") out.add(r);
    }
    return out;
  };

  /** Flags read anywhere in a block's statements (an over-approximation, see above). */
  const stmtFlagReads = (b: IrBlock): Set<string> => {
    const out = new Set<string>();
    const reads = new Set<string>();
    for (const s of b.stmts) {
      switch (s.k) {
        case "set": collectReads(s.v, reads); break;
        case "store": collectReads(s.addr, reads); collectReads(s.v, reads); break;
        case "cpuset": if (s.index) collectReads(s.index, reads); collectReads(s.v, reads); break;
        case "callind": collectReads(s.target, reads); break;
        case "helper": for (const a of s.args) collectReads(a, reads); break;
        case "check": collectReads(s.c, reads); break;
        default: break;
      }
    }
    for (const r of reads) if (FLAG_SET.has(r) || r === "ftop") out.add(r);
    return out;
  };

  const liveIn = (b: IrBlock): Set<string> => {
    const out = new Set(liveOut.get(b.id) ?? []);
    for (const fl of termFlagReads(b.term)) out.add(fl);
    for (const fl of stmtFlagReads(b)) out.add(fl);
    return out;
  };

  // Fixed point: successors of a block are not necessarily later in `f.order`, so this iterates until
  // the sets stop growing.
  const LIMIT = 256;
  for (let round = 0; round < LIMIT; round++) {
    let changed = false;
    for (let i = f.order.length - 1; i >= 0; i--) {
      const b = f.blocks.get(f.order[i])!;
      const out = new Set<string>();
      for (const succ of successors(b.term)) {
        const s = f.blocks.get(succ);
        if (s) for (const fl of liveIn(s)) out.add(fl);
      }
      const prev = liveOut.get(b.id)!;
      if (out.size !== prev.size || [...out].some((x) => !prev.has(x))) {
        liveOut.set(b.id, out);
        changed = true;
      }
    }
    if (!changed) break;
  }

  /** The flag stores of one block that something later can still observe. */
  const liveStores = (b: IrBlock): Set<Stmt> => {
    const keep = new Set<Stmt>();
    const live = new Set(liveOut.get(b.id) ?? []);
    for (const fl of termFlagReads(b.term)) live.add(fl);

    for (let i = b.stmts.length - 1; i >= 0; i--) {
      const s = b.stmts[i];
      if (isWriteOfAnyFlag(s)) {
        const name = (s as { name: string }).name;
        if (live.has(name)) {
          keep.add(s);
          // The value being stored may itself read flags (the lifter derives zf from a comparison).
          const reads = new Set<string>();
          collectReads((s as { v: Expr }).v, reads);
          for (const r of reads) if (FLAG_SET.has(r) || r === "ftop") live.add(r);
          live.delete(name);
        }
        continue;
      }
      switch (s.k) {
        case "set":
        case "store":
        case "cpuset": {
          const reads = new Set<string>();
          const ex = s.k === "set" ? [s.v] : s.k === "store" ? [s.addr, s.v] : s.index ? [s.index, s.v] : [s.v];
          for (const e of ex) collectReads(e, reads);
          for (const r of reads) if (FLAG_SET.has(r) || r === "ftop") live.add(r);
          break;
        }
        case "syncout":
          // The callee can read the whole Cpu struct: every flag is observable again.
          for (const fl of FLAGS) live.add(fl);
          live.add("ftop");
          break;
        case "callguest":
        case "callind":
        case "callhle":
        case "helper":
          for (const fl of FLAGS) live.add(fl);
          live.add("ftop");
          break;
        case "check": {
          const reads = new Set<string>();
          collectReads(s.c, reads);
          for (const r of reads) if (FLAG_SET.has(r) || r === "ftop") live.add(r);
          break;
        }
        default:
          break;
      }
    }
    return keep;
  };

  let removed = 0;
  const blocks = new Map<string, IrBlock>();
  for (const [id, b] of f.blocks) {
    const keep = liveStores(b);
    const stmts = b.stmts.filter((s) => {
      if (!isWriteOfAnyFlag(s)) return true;
      if (keep.has(s)) return true;
      removed++;
      return false;
    });
    blocks.set(id, { ...b, stmts });
  }
  return { functions: { ...f, blocks }, removed };
}

/**
 * Publish/reload pairs that cancel out.
 *
 * `syncout` writes every guest register from the pinned registers to the `Cpu` struct and `syncin`
 * loads them straight back: adjacent, they are a handful of stores and loads that leave the same values
 * in the same registers. The emitter cannot see this because it works one statement at a time.
 *
 * Only *adjacent* pairs are removed. Anything in between (a call, a store) may observe the struct, and
 * a `syncout` at the end of a block is the publication a following block relies on.
 */
export function removeRedundantSyncs(f: IrFunc): { functions: IrFunc; removed: number } {
  let removed = 0;
  const blocks = new Map<string, IrBlock>();
  for (const [id, b] of f.blocks) {
    const stmts: Stmt[] = [];
    for (const s of b.stmts) {
      const prev = stmts[stmts.length - 1];
      if (s.k === "syncin" && prev && prev.k === "syncout") {
        stmts.pop();
        removed += 2;
        continue;
      }
      stmts.push(s);
    }
    blocks.set(id, { ...b, stmts });
  }
  return { functions: { ...f, blocks }, removed };
}

/**
 * The whole chain: constants folded, then dead flag stores removed. The order matters -- folding
 * first turns `zf = (x + 0) == 0` into `zf = x == 0`, which the flag pass then sees as a plain read.
 */
export function optimise(f: IrFunc): { functions: IrFunc; folded: number; flagsRemoved: number; syncsRemoved: number } {
  const a = foldConstants(f);
  const b = removeDeadFlags(a.functions);
  const c = removeRedundantSyncs(b.functions);
  return { functions: c.functions, folded: a.folded, flagsRemoved: b.removed, syncsRemoved: c.removed };
}

function successors(t: Term): string[] {
  switch (t.k) {
    case "br": return [t.to];
    case "cbr": return [t.t, t.f];
    case "switch": return [...t.targets, t.dflt];
    case "switchaddr": return [...t.cases.map((c) => c[1]), t.dflt];
    default: return [];
  }
}

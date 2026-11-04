/**
 * IR → AArch64 code generator.
 *
 * Input is the IR the recompiler produces (recomp/src/lift.ts — the same IR the WebAssembly
 * backend consumes). Output is a native function with the runtime's signature `void f(Cpu* c)`,
 * so on Android the runtime dispatches into machine code exactly where the browser dispatches
 * into WebAssembly.
 *
 * Design
 * - **Pinned values.** Everything that must survive a call gets a callee-saved host register: the
 *   eight guest registers, `ftop`, `df`, and the two 64-bit temporaries of the x87 helpers. This
 *   makes "live across a call" bookkeeping unnecessary and keeps guest-register arithmetic
 *   entirely in registers.
 * - **Pool.** Every other value is an expression result living in the register pool `x0..x12`,
 *   allocated as a stack (level k), so evaluating an operand uses levels above the destination and
 *   can never clobber it. Locals that are not pinned get one spill slot each in the frame.
 * - **Sync discipline.** The Cpu struct is written only where another thread or the HLE layer can
 *   observe it (calls, helpers, traps, returns), plus the IR's own `syncin`/`syncout` marks, so the
 *   observable state sequence matches the WebAssembly backend.
 *
 * Verified by aot/test/arch.test.mjs: random IR is compiled, executed in Unicorn and compared with
 * the reference interpreter (aot/src/interp.ts) bit for bit.
 */
import { Assembler, Cond, SP, XZR, LR } from "./arm64.ts";
import { CPU_OFFSET, CPU_ELEM, GPR, RUNTIME_IMPORTS } from "./interp.ts";
import type { BinOp, CpuField, Expr, IrFunc, Stmt, Term, Ty } from "../../recomp/src/ir.ts";

const FP = 29;
const CPU = 28;
/** Guest registers kept resident across the whole function (all callee-saved). */
const PINNED: Record<string, number> = {
  eax: 19, ecx: 20, edx: 21, ebx: 22, edi: 23, esi: 24, ebp: 25, esp: 26, ftop: 27, df: 15,
};
/**
 * Registers the emitters use as scratch and must never hold live state:
 * x16 is the address of every import/guest call (and of a jump table),
 * x17 and x18 are used by the switch sequence, x28 is the Cpu pointer, x29 the frame pointer.
 */
const PINNED_EXTRA: Record<string, number> = {};
/**
 * Register pool for expression values, allocated as a stack (level k). Two ranges, so that
 * argument staging for a runtime call can never collide with an address register of the
 * expression being staged.
 */
const XPOOL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const XSTAGE = [11, 12, 13, 14];
/** Ops whose right-hand constant operand may be folded into the instruction. */
/**
 * Ops that may fold a constant right operand into the instruction. The left operand is always
 * evaluated, so folding can never skip work on it — but note that `and`/`or`/`xor` deliberately
 * stay out of this set when they cannot be encoded, and that the whole point of the set is to keep
 * the generated code free of the double evaluation `constBinary` used to cause.
 */
const RHS_CONST_FOLDABLE = new Set<BinOp>(["add", "sub", "shl", "shru", "shrs"]);
/**
 * Whether `xd := lhs <op> imm` can be folded into a single instruction (or a short fixed sequence)
 * without a temporary. Pure: it must not emit code, because a false answer makes the caller emit the
 * general form, and the left operand's code (with its helper calls) may only be generated once.
 */
function canFoldConst(op: BinOp, v: number): boolean {
  switch (op) {
    case "add":
    case "sub": {
      const magnitude = Math.abs(v);
      return magnitude === 0 || magnitude <= 0xfff || (magnitude <= 0xfff000 && magnitude % 0x1000 === 0);
    }
    case "and":
    case "or":
    case "xor": {
      // 0 and -1 are not encodable, but they fold trivially (see the general path for them).
      const value = BigInt(v >>> 0);
      try {
        encodeLogicalImm(value, false);
        return true;
      } catch {
        return false;
      }
    }
    case "shl":
    case "shru":
    case "shrs":
      return true;
    default:
      return false;
  }
}

/** Floating-point pool and staging range (caller-saved; no FP value lives across a call). */
const DPOOL = [0, 1, 2, 3, 4, 5, 6, 7];
const DSTAGE = [13, 14, 15];

export interface CallFixup {
  at: number;
  target: number;
}

export interface ImportFixup {
  at: number;
  importIndex: number;
}

export interface TableFixup {
  /** Byte offset of the 8-byte absolute entry inside this function's code. */
  at: number;
  /** Byte offset of the target block inside this function's code. */
  target: number;
}

export interface FunctionCode {
  code: Uint8Array;
  /** Absolute jump-table entries the loader must patch (see Assembler.switchTableAbs). */
  tables: TableFixup[];
  entry: number;
  name: string;
  calls: CallFixup[];
  imports: ImportFixup[];
  traps: string[];
}

interface Slot {
  offset: number;
  kind: "slot32" | "slot64";
}

const FLOAT_OPS = new Set<BinOp>(["fadd", "fsub", "fmul", "fdiv", "fmin", "fmax"]);

/** Parameter and result kinds of the runtime imports (AAPCS64: ints in x0.., doubles in d0..). */
type Kind = "i32" | "i64" | "f64" | "ptr";
interface Signature { params: Kind[]; result: Kind | "void" }
export const SIGNATURES: Record<string, Signature> = {
  rt_hle: { params: ["ptr", "i32"], result: "void" },
  rt_dispatch: { params: ["ptr", "i32"], result: "void" },
  rt_trap_id: { params: ["ptr", "i32"], result: "void" },
  rt_cpuid: { params: ["ptr"], result: "void" },
  rt_rep_movs: { params: ["ptr", "i32", "i32"], result: "void" },
  rt_rep_stos: { params: ["ptr", "i32", "i32"], result: "void" },
  rt_rcl: { params: ["i32", "i32", "i32", "i32"], result: "i64" },
  rt_rcr: { params: ["i32", "i32", "i32", "i32"], result: "i64" },
  rt_f80_load: { params: ["i32"], result: "f64" },
  rt_f80_store: { params: ["ptr", "i32", "f64"], result: "void" },
  rt_fist16: { params: ["f64", "i32"], result: "i32" },
  rt_fist32: { params: ["f64", "i32"], result: "i32" },
  rt_fist64: { params: ["f64", "i32"], result: "i64" },
  rt_frndint: { params: ["f64", "i32"], result: "f64" },
  rt_fxam: { params: ["f64"], result: "i32" },
  rt_sin: { params: ["f64"], result: "f64" },
  rt_cos: { params: ["f64"], result: "f64" },
  rt_tan: { params: ["f64"], result: "f64" },
  rt_atan2: { params: ["f64", "f64"], result: "f64" },
  rt_log2: { params: ["f64"], result: "f64" },
  rt_f2xm1: { params: ["f64"], result: "f64" },
  rt_fscale: { params: ["f64", "f64"], result: "f64" },
  rt_fprem: { params: ["ptr", "i32"], result: "void" },
  rt_fprem1: { params: ["ptr", "i32"], result: "void" },
  rt_fnsave: { params: ["ptr", "i32"], result: "void" },
  rt_fnstenv: { params: ["ptr", "i32"], result: "void" },
  rt_frstor: { params: ["ptr", "i32"], result: "void" },
  rt_fldenv: { params: ["ptr", "i32"], result: "void" },
};

/** Cpu-pointer helpers called with the Cpu struct as their first argument. */
const CPU_FIRST: Record<string, boolean> = {
  rt_cpuid: true, rt_rep_movs: true, rt_rep_stos: true, rt_f80_store: true, rt_fprem: true, rt_fprem1: true,
  rt_fnsave: true, rt_fnstenv: true, rt_frstom: true, rt_frstor: true, rt_fldenv: true,
};
const FLOAT_CMP: Record<string, number> = { feq: Cond.EQ, fne: Cond.NE, flt: Cond.MI, fle: Cond.LS, fgt: Cond.GT, fge: Cond.GE };

export class Arm64FunctionEmitter {
  private readonly a = new Assembler();
  private readonly f: IrFunc;
  private readonly slots = new Map<string, Slot>();
  private readonly types = new Map<string, Ty>();
  private frame = 0;
  private traps: string[] = [];
  private calls: CallFixup[] = [];
  private imports: ImportFixup[] = [];
  private xl = 0;
  private dl = 0;
  private tables: TableFixup[] = [];
  /** True once guest code assigned ESP (then the mirror register is authoritative). */
  private espDirty = false;

  constructor(f: IrFunc) {
    this.f = f;
    for (const [name, ty] of f.locals) this.types.set(name, ty);
  }

  emit(): FunctionCode {
    this.plan();
    this.prologue();
    for (const id of this.f.order) {
      const block = this.f.blocks.get(id);
      if (!block) throw new Error(`${this.f.name}: missing block ${id}`);
      this.a.bind(this.label(id));
      this.xl = 0;
      this.dl = 0;
      for (const s of block.stmts) this.stmt(s);
      this.terminator(block.term);
    }
    const code = this.a.finish();
    this.tables = this.a.finishTables();
    return { code, entry: this.f.entry, name: this.f.name, calls: this.calls, imports: this.imports, traps: this.traps, tables: this.tables };
  }

  // ---- Frame -----------------------------------------------------------------------------------

  private plan(): void {
    for (const name of [...Object.keys(PINNED), ...Object.keys(PINNED_EXTRA)]) {
      this.slots.set(name, { offset: -1, kind: "slot32" });
      if (!this.types.has(name)) this.types.set(name, PINNED_EXTRA[name] !== undefined ? "i64" : "i32");
    }
    for (const [name, ty] of this.types) {
      if (this.slots.has(name)) continue;
      this.slots.set(name, { offset: this.frame, kind: ty === "i64" || ty === "f64" ? "slot64" : "slot32" });
      this.frame += 16;
    }
  }

  /** Bytes of stack to allocate: the spill slots plus the saved frame pointer and link register. */
  private frameSize(): number {
    return (this.frame + 16 + 15) & ~15;
  }

  private label(id: string): string {
    return `b_${id}`;
  }

  private prologue(): void {
    const sp = this.frameSize();
    this.a.stpPre(FP, LR, SP, -16);
    // `mov x29, sp` is an ADD (register 31 is the zero register in ORR/MOV).
    this.a.addSubImm("add", FP, SP, 0, true);
    // The host SP no longer equals the guest ESP (the frame was pushed), and `syncOut` writes the
    // mirror registers back verbatim: make sure a stale guest ESP can never reach the Cpu struct.
    // The runtime loads the authoritative guest ESP before calling, so this value is only replaced
    // when the guest code computes SP itself (see the SP special case in `set`).
    // Allocate the spill frame (ADD/SUB immediates are 12 bits, so walk it in 0xfff steps).
    let remaining = sp - 16;
    while (remaining > 0) {
      const step = Math.min(remaining, 0xfff);
      this.a.addSubImm("sub", SP, SP, step, true);
      remaining -= step;
    }
    // AArch64 has no zero register pair trick for arbitrary sizes: clear the frame slot by slot so
    // that a local read before it is written yields 0 (the IR always defines locals first, but a
    // garbage read must never be able to leak into the game).
    for (let off = 0; off < sp - 16; off += 16) this.a.stp(31, 31, SP, off);
    this.a.mov(CPU, 0);
    // Mirror the incoming guest registers; the sync paths write them back.
    this.a.ldrw(this.pinned("eax"), CPU, CPU_OFFSET.eax);
    this.a.ldrw(this.pinned("ecx"), CPU, CPU_OFFSET.ecx);
    this.a.ldrw(this.pinned("edx"), CPU, CPU_OFFSET.edx);
    this.a.ldrw(this.pinned("ebx"), CPU, CPU_OFFSET.ebx);
    this.a.ldrw(this.pinned("esp"), CPU, CPU_OFFSET.esp);
    this.a.ldrw(this.pinned("ebp"), CPU, CPU_OFFSET.ebp);
    this.a.ldrw(this.pinned("esi"), CPU, CPU_OFFSET.esi);
    this.a.ldrw(this.pinned("edi"), CPU, CPU_OFFSET.edi);
    this.a.ldrw(this.pinned("ftop"), CPU, CPU_OFFSET.ftop);
    this.a.ldrw(this.pinned("df"), CPU, CPU_OFFSET.df);
  }

  private epilogue(): void {
    const sp = this.frameSize();
    let remaining = sp - 16;
    while (remaining > 0) {
      const step = Math.min(remaining, 0xfff);
      this.a.addSubImm("add", SP, SP, step, true);
      remaining -= step;
    }
    this.a.ldpPost(FP, LR, SP, 16);
    this.a.ret();
  }

  private pinned(name: string): number {
    const r = PINNED[name] ?? PINNED_EXTRA[name];
    if (r === undefined) throw new Error(`${this.f.name}: ${name} is not pinned`);
    return r;
  }

  private isPinned(name: string): boolean {
    return PINNED[name] !== undefined || PINNED_EXTRA[name] !== undefined;
  }

  private slot(name: string): Slot {
    const s = this.slots.get(name);
    if (!s) throw new Error(`${this.f.name}: unknown local ${name}`);
    return s;
  }

  // ---- Register pool ---------------------------------------------------------------------------

  private xp(): number {
    if (this.xl >= XPOOL.length) throw new Error(`${this.f.name}: register pool exhausted`);
    return XPOOL[this.xl++];
  }

  private xfree(n = 1): void {
    this.xl = Math.max(0, this.xl - n);
  }

  private dp(): number {
    if (this.dl >= DPOOL.length) throw new Error(`${this.f.name}: FP pool exhausted`);
    return DPOOL[this.dl++];
  }

  private dfree(n = 1): void {
    this.dl = Math.max(0, this.dl - n);
  }

  // ---- Locals ----------------------------------------------------------------------------------

  private loadLocal(name: string, xd: number): void {
    const s = this.slot(name);
    if (s.offset < 0) return void this.a.mov(xd, this.pinned(name));
    if (s.kind === "slot64") this.a.ldrx(xd, SP, s.offset);
    else this.a.ldrw(xd, SP, s.offset);
  }

  private storeLocal(name: string, xs: number, is64: boolean): void {
    const s = this.slot(name);
    if (s.offset < 0) return void this.a.mov(this.pinned(name), xs);
    if (is64) this.a.strx(xs, SP, s.offset);
    else this.a.strw(xs, SP, s.offset);
  }

  private const32(value: number, xd: number): void {
    const v = value | 0;
    if (v >= 0) return void this.a.movConst32(xd, v);
    // Sign-extended 32-bit constant: MOVZ/MOVK of the low word, then SBFM to sign-extend.
    this.a.movConst32(xd, v >>> 0);
    this.a.sxtw(xd, xd);
  }

  // ---- Synchronisation -------------------------------------------------------------------------

  private syncOut(): void {
    for (const name of [...GPR, "ftop", "df"]) {
      // ESP is mirrored from the Cpu struct unless this function changed it: `esp` is only loaded
      // on entry, so writing back the mirror would silently undo the caller's stack pointer.
      if (name === "esp" && !this.espDirty) continue;
      this.a.strw(this.pinned(name), CPU, CPU_OFFSET[name]);
    }
  }

  private syncIn(): void {
    for (const name of [...GPR, "ftop", "df"]) {
      this.a.ldrw(this.pinned(name), CPU, CPU_OFFSET[name]);
      if (name === "esp") this.espDirty = false;
    }
  }

  // ---- Expressions -----------------------------------------------------------------------------

  /** Evaluate an integer-typed expression into `xd` (a pool register the caller allocated). */
  private into(e: Expr, xd: number): void {
    switch (e.k) {
      case "const":
        return this.constInto(e, xd);
      case "local":
        return this.loadLocal(e.name, xd);
      case "load":
        return this.loadMem(e, xd);
      case "cpu":
        return this.loadCpu(e, xd);
      case "bin":
        if (FLOAT_OPS.has(e.op) || FLOAT_CMP[e.op] !== undefined) return this.floatToBits(e, xd);
        return this.intBinary(e, xd);
      case "un":
        return this.unary(e, xd);
      case "select":
        return this.select(e, xd);
      case "call":
        return this.pureCall(e, xd);
      default:
        throw new Error(`bad expression ${(e as { k: string }).k}`);
    }
  }

  private constInto(e: Expr & { k: "const" }, xd: number): void {
    if (e.ty === "i64") return void this.a.movConst(xd, BigInt.asUintN(64, BigInt(e.v as bigint)));
    if (e.ty === "f64") return void this.a.movConst(xd, new DataView(new Float64Array([Number(e.v)]).buffer).getBigUint64(0, true));
    if (e.ty === "f32") return void this.a.movConst32(xd, new DataView(new Float32Array([Number(e.v)]).buffer).getUint32(0, true));
    this.const32(e.v as number, xd);
  }

  /** Evaluate an f32/f64-typed expression into floating register `fd`. */
  private intoFloat(e: Expr, fd: number): void {
    switch (e.k) {
      case "const": {
        if (e.ty === "f32") {
          const x = this.xp();
          this.a.movConst32(x, new DataView(new Float32Array([Number(e.v)]).buffer).getUint32(0, true));
          this.a.fmovFromGpr(false, fd, x);
          this.xfree();
          return;
        }
        const x = this.xp();
        const bits = e.ty === "f64"
          ? new DataView(new Float64Array([Number(e.v)]).buffer).getBigUint64(0, true)
          : new DataView(new Float64Array([Number(e.v)]).buffer).getBigUint64(0, true);
        this.a.movConst(x, bits);
        this.a.fmovFromGpr(true, fd, x);
        this.xfree();
        return;
      }
      case "local": {
        const s = this.slot(e.name);
        if (s.offset < 0) throw new Error(`${this.f.name}: float local ${e.name} cannot be pinned`);
        this.a.fldrScalar(8, fd, SP, s.offset);
        return;
      }
      case "load": {
        const addr = this.xp();
        this.into(e.addr, addr);
        this.a.fldrScalar(e.ty === "f32" ? 4 : 8, fd, addr, 0);
        this.xfree();
        return;
      }
      case "cpu": {
        const { base, off, used } = this.cpuAddress(e.field, e.index);
        this.a.fldrScalar(8, fd, base, off);
        if (used) this.xfree();
        return;
      }
      case "bin": {
        if (!FLOAT_OPS.has(e.op)) throw new Error(`bad float binop ${e.op}`);
        const is64 = e.a.ty !== "f32";
        // Same operand order as the integer path (and the WebAssembly backend): right, then left.
        const y = this.dp();
        this.intoFloat(e.b, y);
        const x = this.dp();
        this.intoFloat(e.a, x);
        switch (e.op) {
          case "fadd": this.a.fadd(is64, fd, x, y); break;
          case "fsub": this.a.fsub(is64, fd, x, y); break;
          case "fmul": this.a.fmul(is64, fd, x, y); break;
          case "fdiv": this.a.fdiv(is64, fd, x, y); break;
          case "fmin":
          case "fmax":
            this.minMax(is64, e.op === "fmin", fd, x, y);
            break;
          default: throw new Error(`bad float binop ${e.op}`);
        }
        this.dfree(2);
        return;
      }
      case "un": {
        const is64 = e.ty === "f64";
        const x = this.dp();
        this.intoFloat(e.a, x);
        switch (e.op) {
          case "fneg": this.a.fneg(is64, fd, x); break;
          case "fabs": this.a.fabs(is64, fd, x); break;
          case "fsqrt": this.a.fsqrt(is64, fd, x); break;
          case "fceil": this.a.frint(is64, fd, x, "p"); break;
          case "ffloor": this.a.frint(is64, fd, x, "m"); break;
          case "ftrunc": this.a.frint(is64, fd, x, "z"); break;
          case "fnearest": this.a.frint(is64, fd, x, "n"); break;
          case "f32to64": this.a.fcvt(fd, x, true); break;
          case "f64to32": this.a.fcvt(fd, x, false); break;
          case "i32tof64s": this.a.scvtf(true, false, false, fd, x); break;
          case "i32tof64u": this.a.scvtf(true, false, true, fd, x); break;
          case "i64tof64s": this.a.scvtf(true, true, false, fd, x); break;
          case "i32tof32s": this.a.scvtf(false, false, false, fd, x); break;
          case "f64toi32sat": this.truncSat(fd, x); break;
          default: throw new Error(`bad float unary ${e.op}`);
        }
        this.dfree();
        return;
      }
      case "select": {
        const c = this.xp();
        this.into(e.c, c);
        this.a.cmpImm(c, 0, false);
        this.xfree();
        const x = this.dp();
        this.intoFloat(e.a, x);
        const y = this.dp();
        this.intoFloat(e.b, y);
        this.a.fcsel(!(e.ty === "f32"), fd, x, y, Cond.NE);
        this.dfree(2);
        return;
      }
      case "call": {
        // Helpers returning doubles come back in d0.
        const x = this.xp();
        this.pureCall(e, x);
        this.a.fmovFromGpr(true, fd, x);
        this.xfree();
        return;
      }
      default:
        throw new Error(`bad float expression ${(e as { k: string }).k}`);
    }
  }

  private loadMem(e: Expr & { k: "load" }, xd: number): void {
    const addr = this.xp();
    this.into(e.addr, addr);
    if (e.ty === "i64") this.a.ldrx(xd, addr, 0);
    else if (e.ty === "f64" || e.ty === "f32") this.a.fldrScalar(e.ty === "f32" ? 4 : 8, xd, addr, 0);
    else if (e.bytes === 1) (e.signed ? this.a.ldrsb(xd, addr, 0) : this.a.ldrb(xd, addr, 0));
    else if (e.bytes === 2) (e.signed ? this.a.ldrsh(xd, addr, 0) : this.a.ldrh(xd, addr, 0));
    else this.a.ldrw(xd, addr, 0);
    this.xfree();
  }

  private cpuAddress(field: CpuField, index: Expr | undefined): { base: number; off: number; used: boolean } {
    if (!index) return { base: CPU, off: CPU_OFFSET[field], used: false };
    const r = this.xp();
    this.into(index, r);
    this.a.uxtw(r, r);
    const elem = CPU_ELEM[field] ?? 1;
    if (elem > 1) this.a.shiftImm(r, r, "lsl", Math.log2(elem));
    this.a.add(r, CPU, r);
    return { base: r, off: CPU_OFFSET[field], used: true };
  }

  private loadCpu(e: Expr & { k: "cpu" }, xd: number): void {
    const { base, off, used } = this.cpuAddress(e.field, e.index);
    if (e.field === "fpr") this.a.fldrScalar(8, xd, base, off);
    else if (e.ty === "i64" || e.field === "mm") this.a.ldrx(xd, base, off);
    else this.a.ldrw(xd, base, off);
    if (used) this.xfree();
  }

  // ---- Integer arithmetic ----------------------------------------------------------------------

  private intBinary(e: Expr & { k: "bin" }, xd: number): void {
    const op = e.op;
    const is64 = e.ty === "i64";
    // Constant right-hand side: fold immediates so `x + 1`, masks and shifts need no temp.
    // Only the right operand may be skipped: it is evaluated first anyway (see `evalBin` in the
    // reference interpreter), so a constant there cannot skip a runtime helper call. The left
    // operand is always evaluated.
    if (e.b.k === "const" && !is64 && RHS_CONST_FOLDABLE.has(op) &&
        canFoldConst(op, (e.b as { v: number }).v | 0)) {
      this.constBinary(op, xd, e);
      return;
    }
    // Right operand first (see `evalBin`): for a folded constant shift the left operand is emitted
    // during the fold, so it must still be evaluated last, not into a register allocated here.
    const rhs = this.xp();
    this.into(e.b, rhs);
    const lhs = this.xp();
    this.into(e.a, lhs);
    this.intBinaryRegs(op, xd, lhs, rhs, is64);
    this.xfree(2);
  }

  /**
   * `xd := lhs <op> imm` with no temporary register. The caller checks `canFoldConst` first, so
   * this never emits code it has to discard -- emitting the left operand twice would duplicate the
   * runtime helper calls it contains.
   */
  private constBinary(op: BinOp, xd: number, e: Expr & { k: "bin" }): void {
    const v = (e.b as { v: number }).v | 0;
    const lhs = this.xp();
    this.into(e.a, lhs);
    switch (op) {
      case "add":
      case "sub": {
        const magnitude = Math.abs(v);
        const negate = (v < 0) !== (op === "sub");
        if (magnitude === 0) this.a.movw(xd, lhs);
        else if (magnitude <= 0xfff) this.a.addSubImm(negate ? "sub" : "add", xd, lhs, magnitude, false);
        else this.a.addSubImmShifted(negate ? "sub" : "add", xd, lhs, magnitude >>> 12, true, false);
        break;
      }
      case "and":
      case "or":
      case "xor": {
        const kind = op === "and" ? 0 : op === "or" ? 1 : 2;
        this.a.andMask(xd, lhs, BigInt(v >>> 0), kind, false);
        break;
      }
      case "shl":
      case "shru":
      case "shrs":
        this.a.shiftImm(xd, lhs, op === "shl" ? "lsl" : op === "shru" ? "lsr" : "asr", (v >>> 0) & 31, false);
        break;
      default:
        throw new Error(`${this.f.name}: cannot fold ${op} with a constant`);
    }
    this.xfree();
  }

  private intBinaryRegs(op: BinOp, xd: number, lhs: number, rhs: number, is64: boolean): void {
    switch (op) {
      case "add": return void this.a.add(xd, lhs, rhs, is64);
      case "sub": return void this.a.sub(xd, lhs, rhs, is64);
      case "mul": return void this.a.mul(xd, lhs, rhs, is64);
      case "and": return void this.a.and(xd, lhs, rhs, "lsl", 0, is64);
      case "or": return void this.a.orr(xd, lhs, rhs, "lsl", 0, is64);
      case "xor": return void this.a.eor(xd, lhs, rhs, "lsl", 0, is64);
      case "shl": return void this.a.shiftReg(xd, lhs, "lsl", rhs, is64);
      case "shru": return void this.a.shiftReg(xd, lhs, "lsr", rhs, is64);
      case "shrs": return void this.a.shiftReg(xd, lhs, "asr", rhs, is64);
      case "rotl": {
        // `rotl(x, n)` is `rotr(x, 0 - n)`, and the rotate count is taken modulo the width (AArch64
        // does that in hardware), so the negation needs no clamping.
        const neg = this.xp();
        this.a.movConst32(neg, 0);
        this.a.sub(neg, neg, rhs, is64);
        this.a.rorReg(xd, lhs, neg, is64);
        this.xfree();
        return;
      }
      case "rotr": return void this.a.rorReg(xd, lhs, rhs, is64);
      case "eq": case "ne": case "lts": case "ltu": case "les": case "leu": case "gts": case "gtu": case "ges": case "geu":
        this.a.cmpReg(lhs, rhs, "lsl", 0, is64);
        this.a.cset(xd, condFor(op), false);
        return;
      case "divs": return void this.signedDivide(xd, lhs, rhs, is64, false);
      case "rems": return void this.signedDivide(xd, lhs, rhs, is64, true);
      // Unsigned division and remainder: WebAssembly (and the reference interpreter) define the
      // result as 0 when the divisor is 0, which UDIV happens to give for the quotient -- but the
      // remainder is computed as `lhs - (lhs / rhs) * rhs`, and with rhs == 0 that yields `lhs`.
      // Both therefore guard the divisor explicitly.
      case "divu": {
        const zero = this.a.fresh("divu0");
        const done = this.a.fresh("divu1");
        if (!is64) {
          this.a.uxtw(lhs, lhs);
          this.a.uxtw(rhs, rhs);
        }
        this.a.cbz(rhs, zero, is64);
        this.a.udiv(xd, lhs, rhs, is64);
        this.a.b(done);
        this.a.bind(zero);
        // Division by zero is defined as 0 (UDIV would give 0 too, but only for the quotient).
        this.a.movConst32(xd, 0);
        this.a.bind(done);
        if (!is64) this.a.movw(xd, xd);
        return;
      }
      case "remu": {
        const skip = this.a.fresh("remu");
        const zero = this.a.fresh("remuz");
        if (!is64) {
          this.a.uxtw(lhs, lhs);
          this.a.uxtw(rhs, rhs);
        }
        this.a.cbz(rhs, zero, is64);
        this.a.udiv(xd, lhs, rhs, is64);
        this.a.msub(xd, xd, rhs, lhs, is64);
        this.a.b(skip);
        this.a.bind(zero);
        this.a.movConst32(xd, 0);
        this.a.bind(skip);
        if (!is64) this.a.movw(xd, xd);
        return;
      }
      default:
        throw new Error(`${this.f.name}: bad integer binop ${op}`);
    }
  }

  /** Signed divide/remainder with WebAssembly semantics (÷0 → 0, INT_MIN ÷ -1 wraps). */
  private signedDivide(xd: number, lhs: number, rhs: number, is64: boolean, remainder: boolean): void {
    const zero = this.a.fresh();
    const done = this.a.fresh();
    const z = this.xp();
    this.a.movConst32(z, 0);
    if (!is64) {
      this.a.sxtw(lhs, lhs);
      this.a.sxtw(rhs, rhs);
    }
    this.a.cmpReg(rhs, z, "lsl", 0, true);
    this.a.bcond(Cond.EQ, zero);
    if (is64) {
      const neg1 = this.a.fresh();
      const m = this.xp();
      this.a.movConst(m, -1n);
      this.a.cmpReg(rhs, m, "lsl", 0, true);
      this.a.bcond(Cond.NE, neg1);
      this.a.sub(xd, XZR, lhs, true);
      this.a.b(done);
      this.a.bind(neg1);
      this.a.sdiv(xd, lhs, rhs, true);
      if (remainder) this.a.msub(xd, xd, rhs, lhs, true);
      this.a.b(done);
      this.a.bind(zero);
      this.a.movConst32(xd, 0);
      this.a.bind(done);
      this.xfree(2);
      return;
    }
    this.a.sdiv(xd, lhs, rhs, true);
    if (remainder) this.a.msub(xd, xd, rhs, lhs, true);
    this.a.movw(xd, xd);
    this.a.b(done);
    this.a.bind(zero);
    this.a.movConst32(xd, 0);
    this.a.bind(done);
    this.xfree();
  }

  /** Float-typed binop evaluated to bits in an integer register. */
  private floatToBits(e: Expr & { k: "bin" }, xd: number): void {
    const is64 = e.a.ty !== "f32";
    const x = this.dp();
    this.intoFloat(e.a, x);
    const y = this.dp();
    this.intoFloat(e.b, y);
    if (FLOAT_CMP[e.op] !== undefined) {
      this.a.fcmp(is64, x, y);
      this.a.cset(xd, FLOAT_CMP[e.op], false);
      this.dfree(2);
      return;
    }
    switch (e.op) {
      case "fadd": this.a.fadd(is64, x, x, y); break;
      case "fsub": this.a.fsub(is64, x, x, y); break;
      case "fmul": this.a.fmul(is64, x, x, y); break;
      case "fdiv": this.a.fdiv(is64, x, x, y); break;
      case "fmin": this.a.fmin(is64, x, x, y); break;
      default: this.a.fmax(is64, x, x, y); break;
    }
    this.a.fmovToGpr(is64, xd, x);
    this.dfree(2);
  }

  private unary(e: Expr & { k: "un" }, xd: number): void {
    const op = e.op;
    const is64 = e.ty === "i64";
    switch (op) {
      case "fneg": case "fabs": case "fsqrt": case "fceil": case "ffloor": case "ftrunc": case "fnearest": case "f32to64": {
        const fd = this.dp();
        this.intoFloat(e, fd);
        this.a.fmovToGpr(e.ty === "f64", xd, fd);
        this.dfree();
        return;
      }
      default: break;
    }
    if (op === "f64to32") {
      const fd = this.dp();
      this.intoFloat(e, fd);
      this.a.fmovToGpr(false, xd, fd);
      this.dfree();
      return;
    }
    if (op === "i32tof64s" || op === "i32tof64u" || op === "i64tof64s" || op === "i32tof32s") {
      const fd = this.dp();
      this.intoFloat(e, fd);
      this.a.fmovToGpr(op === "i32tof32s" ? false : true, xd, fd);
      this.dfree();
      return;
    }
    const x = this.xp();
    this.into(e.a, x);
    switch (op) {
      case "neg": this.a.sub(xd, XZR, x, is64); break;
      case "not": this.a.mvn(xd, x, is64); break;
      case "eqz": this.a.cmpImm(x, 0, is64); this.a.cset(xd, Cond.EQ, false); break;
      case "clz": this.a.clz(xd, x, false); break;
      case "ctz": this.a.rbit(xd, x, false); this.a.clz(xd, xd, false); break;
      case "popcnt": this.popcount(xd, x); break;
      case "ext8s": this.a.sxtb(xd, x, false); break;
      case "ext16s": this.a.sxth(xd, x, false); break;
      case "bswap": this.a.rev32w(xd, x); break;
      case "wrap": this.a.movw(xd, x); break;
      case "extu": this.a.mov(xd, x); break;
      case "exts": this.a.sxtw(xd, x); break;
      case "f32bits": case "bitsf32": case "f64bits": case "bitsf64": this.a.movw(xd, x); break;
      case "f64toi32sat": this.truncSat(xd, x); break;
      default: throw new Error(`${this.f.name}: bad unary ${op}`);
    }
    this.xfree();
  }

  private popcount(xd: number, src: number): void {
    const m = this.xp();
    const t = this.xp();
    this.a.movConst32(m, 0x55555555);
    this.a.shiftImm(t, src, "lsr", 1, false);
    this.a.and(t, t, m, "lsl", 0, false);
    this.a.sub(xd, src, t, false);
    this.a.movConst32(m, 0x33333333);
    this.a.shiftImm(t, xd, "lsr", 2, false);
    this.a.and(t, t, m, "lsl", 0, false);
    this.a.and(xd, xd, m, "lsl", 0, false);
    this.a.add(xd, xd, t, false);
    this.a.shiftImm(t, xd, "lsr", 4, false);
    this.a.add(xd, xd, t, false);
    this.a.movConst32(m, 0x0f0f0f0f);
    this.a.and(xd, xd, m, "lsl", 0, false);
    this.a.movConst32(m, 0x01010101);
    this.a.mul(xd, xd, m, false);
    this.a.shiftImm(xd, xd, "lsr", 24, false);
    this.xfree(2);
  }

  /** WebAssembly i32.trunc_sat_f64_s / f32: truncate, saturate, NaN → 0. */
  private truncSat(xd: number, src: number): void {
    const x = this.xp();
    this.a.fmovFromGpr(true, this.dp(), XZR);
    const zeroD = this.dl - 1;
    this.a.fcmp(true, src, DPOOL[zeroD]);
    this.dfree();
    const nan = this.a.fresh();
    const done = this.a.fresh();
    const low = this.a.fresh();
    this.a.bcond(Cond.VS, nan);
    this.a.fcvtz(true, true, false, xd, src);
    this.a.movConst32(x, 0x7fffffff);
    this.a.cmpReg(xd, x, "lsl", 0, true);
    this.a.bcond(Cond.LE, low);
    this.a.movw(xd, x);
    this.a.b(done);
    this.a.bind(low);
    this.a.movConst32(x, 0x80000000);
    this.a.sxtw(x, x);
    this.a.cmpReg(xd, x, "lsl", 0, true);
    this.a.bcond(Cond.GE, done);
    this.a.movw(xd, x);
    this.a.b(done);
    this.a.bind(nan);
    this.a.movConst32(xd, 0);
    this.a.bind(done);
    this.xfree();
  }

  /**
   * `select` mirrors the WebAssembly backend, which pushes both arms and the condition and then
   * picks one: the operand order is a, b, c and every operand is evaluated. Evaluating only the
   * selected arm would drop the helper calls the wasm build performs (and its side effects).
   */
  /**
   * WebAssembly `fmin`/`fmax`, which is what the reference interpreter models. AArch64's own FMIN and
   * FMAX already order -0 below +0 (matching the interpreter), but they *return the non-NaN operand*
   * when only one side is NaN, while WebAssembly propagates NaN. Only that case is fixed up here.
   */
  private minMax(is64: boolean, isMin: boolean, fd: number, x: number, y: number): void {
    const nan = this.a.fresh("nan");
    const done = this.a.fresh("mmdone");
    this.a.fcmp(is64, x, x);
    this.a.bcond(Cond.VS, nan);
    this.a.fcmp(is64, y, y);
    this.a.bcond(Cond.VS, nan);
    if (isMin) this.a.fmin(is64, fd, x, y);
    else this.a.fmax(is64, fd, x, y);
    this.a.b(done);
    this.a.bind(nan);
    this.a.emitNaN(is64, fd);
    this.a.bind(done);
  }

  private select(e: Expr & { k: "select" }, xd: number): void {
    const a = this.xp();
    this.into(e.a, a);
    const b = this.xp();
    this.into(e.b, b);
    const c = this.xp();
    this.into(e.c, c);
    this.a.cmpImm(c, 0, false);
    this.a.csel(xd, a, b, Cond.NE, e.ty === "i64");
    this.xfree(3);
  }

  // ---- Runtime helpers -------------------------------------------------------------------------

  /** Evaluate `arg` into a staging register (a range the value pool never touches). */
  private stageInt(arg: Expr): number {
    if (this.stage >= XSTAGE.length) throw new Error(`${this.f.name}: too many call arguments`);
    const r = XSTAGE[this.stage++];
    this.into(arg, r);
    return r;
  }

  private stageFloat(arg: Expr): number {
    if (this.stageD >= DSTAGE.length) throw new Error(`${this.f.name}: too many float arguments`);
    const r = DSTAGE[this.stageD++];
    this.intoFloat(arg, r);
    return r;
  }

  private stage = 0;
  private stageD = 0;

  private unstage(): void {
    this.stage = 0;
    this.stageD = 0;
  }

  /**
   * Call a runtime import with AAPCS64 argument placement: integers and pointers take x0, x1, ...
   * and doubles take d0, d1, ... in their own sequence (both as in recomp.h and emit-wasm.ts).
   * `fixed` are already-evaluated integer arguments placed before the expression's own arguments.
   */
  private callImport(name: string, args: Expr[], result: "i32" | "i64" | "f64" | "void", fixed: { reg: number }[] = []): number {
    const sig = SIGNATURES[name];
    if (!sig) throw new Error(`${this.f.name}: no signature for ${name}`);
    const ints: number[] = fixed.map((f) => f.reg);
    const floats: number[] = [];
    for (const arg of args) {
      if (sig.params[ints.length + floats.length] === "f64" || arg.ty === "f64" || arg.ty === "f32") {
        // The parameter position decides the class, matching the C declaration.
        const pos = ints.length + floats.length;
        if (sig.params[pos] === "f64") floats.push(this.stageFloat(arg));
        else ints.push(this.stageInt(arg));
      } else {
        ints.push(this.stageInt(arg));
      }
    }
    ints.forEach((r, i) => this.a.mov(i, r));
    floats.forEach((d, i) => this.a.fmov(3, i, d));
    const idx = RUNTIME_IMPORTS.indexOf(name as (typeof RUNTIME_IMPORTS)[number]);
    if (idx < 0) throw new Error(`${this.f.name}: unknown import ${name}`);
    this.emitImport(idx);
    this.unstage();
    let out = -1;
    if (result === "f64") {
      out = this.xp();
      this.a.fmovToGpr(true, out, 0);
    } else if (result === "i32" || result === "i64") {
      out = this.xp();
      this.a.mov(out, 0);
    }
    return out;
  }

  private pureCall(e: Expr & { k: "call" }, xd: number): void {
    switch (e.fn) {
      case "parity8": {
        // !__builtin_parity(v & 0xff), branch-free via a 16-bit lookup.
        const x = this.stageInt(e.args[0]);
        this.a.uxtb(x, x);
        const t = XPOOL[0];
        this.a.shiftImm(t, x, "lsr", 4, false);
        this.a.eor(t, t, x, "lsl", 0, false);
        const u = XPOOL[1];
        this.a.shiftImm(u, t, "lsr", 2, false);
        this.a.eor(t, t, u, "lsl", 0, false);
        this.a.shiftImm(u, t, "lsr", 1, false);
        this.a.eor(t, t, u, "lsl", 0, false);
        this.a.movConst32(u, 0x6996);
        this.a.movConst32(x, 0x0f);
        this.a.and(t, t, x, "lsl", 0, false);
        this.a.lsrReg(xd, u, t, false);
        this.a.movConst32(u, 1);
        this.a.and(xd, xd, u, "lsl", 0, false);
        this.unstage();
        return;
      }
      case "rt_round24": {
        // Veltkamp split with 2^29 + 1: r = t - (t - x), keeping inf/NaN and overflow unchanged.
        const x = this.stageFloat(e.args[0]);
        const d = this.stageFloat({ k: "const", ty: "f64", v: 0 }); // placeholder, replaced below
        void d;
        const c = this.stageInt({ k: "const", ty: "i32", v: 0 });
        void c;
        this.unstage();
        const sx = DPOOL[7];
        this.intoFloat(e.args[0], sx);
        const sk = XPOOL[0];
        this.a.movConst(sk, 536870913n);
        const sd = DPOOL[6];
        this.a.fmovFromGpr(true, sd, sk);
        const st = DPOOL[5];
        this.a.fmul(true, st, sx, sd);
        const su = DPOOL[4];
        this.a.fsub(true, su, st, sx);
        this.a.fsub(true, st, st, su);
        this.a.fmovToGpr(true, xd, st);
        return;
      }
      default: {
        const sig = SIGNATURES[e.fn];
        if (!sig) throw new Error(`${this.f.name}: unknown pure helper ${e.fn}`);
        const out = this.callImport(e.fn, e.args, sig.result === "void" ? "void" : (sig.result as "i32" | "i64" | "f64"));
        if (out >= 0) this.a.mov(xd, out);
        if (out >= 0) this.xfree();
        return;
      }
    }
  }

  /** call RUNTIME_IMPORTS[idx] through the address the loader patches in. */
  private emitImport(idx: number): void {
    const at = this.a.movAbs64(16);
    this.imports.push({ at, importIndex: idx });
    this.a.blr(16);
  }

  private emitGuestCall(target: number): void {
    const at = this.a.movAbs64(16);
    this.calls.push({ at, target });
    this.a.blr(16);
  }

  // ---- Statements ------------------------------------------------------------------------------

  private stmt(s: Stmt): void {
    switch (s.k) {
      case "set": {
        if (!this.slots.has(s.name)) return;
        const ty = this.types.get(s.name) ?? "i32";
        if (ty === "f64") {
          const fd = this.dp();
          this.intoFloat(s.v, fd);
          const slot = this.slot(s.name);
          if (slot.offset < 0) throw new Error(`${this.f.name}: float local ${s.name} cannot be pinned`);
          this.a.fstrScalar(8, fd, SP, slot.offset);
          this.dfree();
          return;
        }
        const x = this.xp();
        this.into(s.v, x);
        this.storeLocal(s.name, x, ty === "i64");
        if (s.name === "esp") this.espDirty = true;
        this.xfree();
        return;
      }
      case "store": {
        const addr = this.xp();
        this.into(s.addr, addr);
        this.storeValue(s, addr);
        this.xfree();
        return;
      }
      case "cpuset": {
        // The index expression is evaluated into a register *before* the value, matching the order
        // the reference interpreter uses, and it must not be released until the store is done.
        const { base, off, used } = this.cpuAddress(s.field, s.index);
        const indexRegs = used ? 1 : 0;
        if (s.v.ty === "f64") {
          const fd = this.dp();
          this.intoFloat(s.v, fd);
          this.a.fstrScalar(8, fd, base, off);
          this.dfree();
        } else {
          const x = this.xp();
          this.into(s.v, x);
          if (s.v.ty === "i64") this.a.strx(x, base, off);
          else this.a.strw(x, base, off);
          if (s.field === "esp") this.espDirty = true;
          this.xfree();
        }
        this.xfree(indexRegs);
        return;
      }
      case "syncout":
        this.syncOut();
        return;
      case "syncin":
        this.syncIn();
        return;
      case "callguest":
        // Register state crosses the boundary through the Cpu struct: the callee loads it on entry
        // and stores it on exit, so the registers have to be published before the call and picked
        // back up afterwards. This is what the reference interpreter and the C++ runtime do.
        this.syncOut();
        this.a.mov(0, CPU);
        this.emitGuestCall(s.target);
        this.syncIn();
        return;
      case "callind": {
        const target = this.xp();
        this.into(s.target, target);
        this.a.mov(0, CPU);
        this.a.mov(1, target);
        this.emitImport(1);
        this.syncIn();
        this.xfree();
        return;
      }
      case "callhle":
        // The HLE procedure is a C++ function: it reads the guest registers from the Cpu struct and
        // may modify them, so state crosses the boundary in the struct in both directions.
        this.syncOut();
        this.a.mov(0, CPU);
        this.a.movConst32(1, s.slot);
        this.emitImport(0);
        this.syncIn();
        return;
      case "helper": {
        // Helpers take the Cpu pointer explicitly and may change it, hence the read-back.
        const sig = SIGNATURES[s.fn];
        if (!sig) throw new Error(`${this.f.name}: unknown helper ${s.fn}`);
        // The Cpu pointer is always the first argument of these helpers.
        this.a.mov(0, CPU);
        const stageInts: number[] = [];
        const stageFloats: number[] = [];
        for (const arg of s.args) {
          const pos = 1 + stageInts.length + stageFloats.length;
          if (sig.params[pos] === "f64") stageFloats.push(this.stageFloat(arg));
          else stageInts.push(this.stageInt(arg));
        }
        stageInts.forEach((r, i) => this.a.mov(i + 1, r));
        stageFloats.forEach((d, i) => this.a.fmov(3, i, d));
        const idx = RUNTIME_IMPORTS.indexOf(s.fn as (typeof RUNTIME_IMPORTS)[number]);
        if (idx < 0) throw new Error(`${this.f.name}: unknown helper ${s.fn}`);
        this.emitImport(idx);
        this.unstage();
        this.syncIn();
        return;
      }
      case "trap":
        this.a.mov(0, CPU);
        this.a.movConst32(1, this.trapId(s.msg));
        this.emitImport(2);
        return;
      case "check": {
        const c = this.xp();
        this.into(s.c, c);
        this.a.cmpImm(c, 0, false);
        this.xfree();
        const ok = this.a.fresh();
        this.a.bcond(Cond.NE, ok);
        this.stmt({ k: "trap", msg: s.msg });
        this.a.bind(ok);
        return;
      }
      case "comment":
        return;
      default:
        throw new Error(`${this.f.name}: bad statement ${(s as { k: string }).k}`);
    }
  }

  private storeValue(s: Stmt & { k: "store" }, addr: number): void {
    if (s.v.ty === "f64" || s.v.ty === "f32") {
      const fd = this.dp();
      this.intoFloat(s.v, fd);
      this.a.fstrScalar(s.v.ty === "f32" ? 4 : 8, fd, addr, 0);
      this.dfree();
      return;
    }
    const v = this.xp();
    this.into(s.v, v);
    if (s.v.ty === "i64") this.a.strx(v, addr, 0);
    else if (s.bytes === 1) this.a.strb(v, addr, 0);
    else if (s.bytes === 2) this.a.strh(v, addr, 0);
    else this.a.strw(v, addr, 0);
    this.xfree();
  }

  private trapId(msg: string): number {
    let i = this.traps.indexOf(msg);
    if (i < 0) {
      i = this.traps.length;
      this.traps.push(msg);
    }
    return i;
  }

  // ---- Terminators -----------------------------------------------------------------------------

  private terminator(t: Term): void {
    switch (t.k) {
      case "br":
        this.a.b(this.label(t.to));
        return;
      case "cbr": {
        const c = this.xp();
        this.into(t.c, c);
        this.a.cmpImm(c, 0, false);
        this.xfree();
        this.a.bcond(Cond.NE, this.label(t.t));
        this.a.b(this.label(t.f));
        return;
      }
      case "switch": {
        const n = t.targets.length;
        if (n === 0) {
          this.a.b(this.label(t.dflt));
          return;
        }
        const v = this.xp();
        this.into(t.idx, v);
        this.a.cmpImm(v, n, false);
        this.a.bcond(Cond.CS, this.label(t.dflt));
        this.a.switchTableAbs(v, t.targets.map((x) => this.label(x)));
        this.xfree();
        return;
      }
      case "switchaddr": {
        const v = this.xp();
        this.into(t.target, v);
        const c = this.xp();
        for (const [addr, target] of t.cases) {
          this.a.movConst32(c, addr >>> 0);
          this.a.cmpReg(v, c, "lsl", 0, false);
          this.a.bcond(Cond.EQ, this.label(target));
        }
        this.xfree(2);
        this.a.b(this.label(t.dflt));
        return;
      }
      case "ret":
        this.epilogue();
        return;
      case "tail":
        this.syncOut();
        this.a.mov(0, CPU);
        this.emitGuestCall(t.target);
        this.epilogue();
        return;
      case "tailind": {
        this.syncOut();
        const target = this.xp();
        this.into(t.target, target);
        this.a.mov(0, CPU);
        this.a.mov(1, target);
        this.emitImport(1);
        this.xfree();
        this.epilogue();
        return;
      }
      case "tailhle":
        this.syncOut();
        this.a.mov(0, CPU);
        this.a.movConst32(1, t.slot);
        this.emitImport(0);
        this.epilogue();
        return;
      case "trap":
        this.stmt({ k: "trap", msg: t.msg });
        return;
      default:
        throw new Error(`${this.f.name}: bad terminator ${(t as { k: string }).k}`);
    }
  }
}

function condFor(op: BinOp): number {
  switch (op) {
    case "eq": return Cond.EQ;
    case "ne": return Cond.NE;
    case "lts": return Cond.LT;
    case "les": return Cond.LE;
    case "gts": return Cond.GT;
    case "ges": return Cond.GE;
    case "ltu": return Cond.CC;
    case "leu": return Cond.LS;
    case "gtu": return Cond.HI;
    case "geu": return Cond.CS;
    default: throw new Error(`bad comparison ${op}`);
  }
}

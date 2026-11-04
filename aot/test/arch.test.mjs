// Differential test of the ARM64 code generator.
//
// For every random IR function: interpret it with the reference interpreter (aot/src/interp.ts) and
// execute the compiled machine code in Unicorn from the same initial guest state. The resulting Cpu
// struct and memory must match exactly. This is what makes it safe to claim the Android build runs
// "the same" code as the verified WebAssembly backend.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Arm64FunctionEmitter } from "../src/arch-arm64.ts";
import { Machine, runFunction, CPU_OFFSET, GPR, RUNTIME_IMPORTS } from "../src/interp.ts";

const MEM_BYTES = 0x100000; // 1 MiB guarded window: guest pointers stay inside it
/** Bytes of the image the runner compares (and therefore has to receive). */
const WINDOW = 0x10000;
const BASE = 0x10000;

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const ri = (n) => Math.floor(rnd() * n);
const pick = (arr) => arr[ri(arr.length)];
const u32 = (x) => x >>> 0;

// ---- IR building helpers ---------------------------------------------------------------------
const c32 = (v) => ({ k: "const", ty: "i32", v: v | 0 });
const c64 = (v) => ({ k: "const", ty: "i64", v: BigInt.asUintN(64, BigInt(v)) });
const cf64 = (v) => ({ k: "const", ty: "f64", v });
const loc = (name, ty = "i32") => ({ k: "local", ty, name });
const bin = (op, a, b, ty = a.ty) => ({ k: "bin", op, ty, a, b });
const un = (op, a, ty) => ({ k: "un", op, ty, a });
const load = (bytes, addr, signed = false, ty) => ({ k: "load", ty: ty ?? (bytes === 8 ? "i64" : "i32"), bytes, signed, addr });
const cpu = (field, ty = "i32", index) => ({ k: "cpu", ty, field, index });
const call = (fn, ty, ...args) => ({ k: "call", ty, fn, args });

class FuncBuilder {
  constructor(entry = 0x401000) {
    this.entry = entry;
    this.locals = new Map();
    this.order = [];
    this.blocks = new Map();
  }
  declare(name, ty = "i32") {
    if (!this.locals.has(name)) this.locals.set(name, ty);
    return loc(name, this.locals.get(name));
  }
  block(id) {
    if (!this.blocks.has(id)) {
      this.blocks.set(id, { id, stmts: [], term: { k: "ret" } });
      this.order.push(id);
    }
    return this.blocks.get(id);
  }
  stmt(id, s) {
    this.block(id).stmts.push(s);
    return this;
  }
  set(id, name, v) {
    return this.stmt(id, { k: "set", name, ty: this.locals.get(name) ?? "i32", v });
  }
  term(id, t) {
    this.block(id).term = t;
    return this;
  }
  build(name = "f") {
    return { entry: this.entry, name, locals: this.locals, order: this.order.slice(), blocks: this.blocks };
  }
}

// ---- Random programs -------------------------------------------------------------------------
const I32_LOCALS = ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"];
const I64_LOCALS = ["q0", "q1"];
const F64_LOCALS = ["d0", "d1"];

function randomExpr(b, ty, depth) {
  if (depth <= 0 || rnd() < 0.3) {
    if (ty === "i32") {
      const r = rnd();
      if (r < 0.5) return b.declare(pick(I32_LOCALS));
      if (r < 0.7) return c32(ri(1 << 20));
      if (r < 0.8) return c32(-ri(1 << 20));
      return cpu(pick(GPR));
    }
    if (ty === "i64") {
      const r = rnd();
      if (r < 0.6) return b.declare(pick(I64_LOCALS), "i64");
      return c64(BigInt(ri(1 << 24)) * 0x1234567n);
    }
    const r = rnd();
    if (r < 0.6) return b.declare(pick(F64_LOCALS), "f64");
    return cf64((ri(2000) - 1000) / 8);
  }
  if (ty === "i32") {
    const kind = ri(12);
    if (kind < 5) return bin(pick(["add", "sub", "mul", "and", "or", "xor"]), randomExpr(b, "i32", depth - 1), randomExpr(b, "i32", depth - 1));
    if (kind < 7) return bin(pick(["shl", "shru", "shrs", "rotl", "rotr"]), randomExpr(b, "i32", depth - 1), randomExpr(b, "i32", depth - 1));
    if (kind < 8) return bin(pick(["divs", "divu", "rems", "remu"]), randomExpr(b, "i32", depth - 1), randomExpr(b, "i32", depth - 1));
    if (kind < 9) return bin(pick(["eq", "ne", "lts", "ltu", "les", "leu", "gts", "gtu", "ges", "geu"]), randomExpr(b, "i32", depth - 1), randomExpr(b, "i32", depth - 1));
    if (kind < 10) return un(pick(["neg", "not", "clz", "ctz", "popcnt", "ext8s", "ext16s", "bswap", "eqz"]), randomExpr(b, "i32", depth - 1), "i32");
    if (kind < 11) return { k: "select", ty: "i32", c: randomExpr(b, "i32", depth - 1), a: randomExpr(b, "i32", depth - 1), b: randomExpr(b, "i32", depth - 1) };
    return call(pick(["rt_fist32", "rt_fxam"]), "i32", randomExpr(b, "f64", depth - 1), c32(0x7f)); // fist32 wants (double, fcw)
  }
  if (ty === "i64") {
    const kind = ri(6);
    if (kind < 3) return bin(pick(["add", "sub", "mul", "and", "or", "xor"]), randomExpr(b, "i64", depth - 1), randomExpr(b, "i64", depth - 1), "i64");
    if (kind < 4) return bin(pick(["shl", "shru", "shrs", "rotl", "rotr"]), randomExpr(b, "i64", depth - 1), randomExpr(b, "i64", depth - 1), "i64");
    if (kind < 5) return bin(pick(["divs", "divu", "rems", "remu"]), randomExpr(b, "i64", depth - 1), randomExpr(b, "i64", depth - 1), "i64");
    return un(pick(["wrap", "clz"]), randomExpr(b, "i64", depth - 1), "i32");
  }
  const kind = ri(4);
  if (kind < 3) return bin(pick(["fadd", "fsub", "fmul", "fdiv", "fmin", "fmax"]), randomExpr(b, "f64", depth - 1), randomExpr(b, "f64", depth - 1), "f64");
  return un(pick(["fneg", "fabs", "ftrunc", "ffloor", "fceil"]), randomExpr(b, "f64", depth - 1), "f64");
}

function randomFunction(index) {
  const b = new FuncBuilder(0x401000 + index * 0x100);
  b.declare("eax"); // guest registers already exist
  for (const l of I32_LOCALS) b.declare(l);
  for (const l of I64_LOCALS) b.declare(l, "i64");
  for (const l of F64_LOCALS) b.declare(l, "f64");
  const blocks = ["B0", "B1", "B2", "B3"];
  for (const bl of blocks) b.block(bl);

  // A small structured-ish program: a loop over B1 with a branch, plus a switch.
  b.set("B0", "t0", randomExpr(b, "i32", 3));
  b.set("B0", "t1", randomExpr(b, "i32", 2));
  b.set("B0", "q0", randomExpr(b, "i64", 2));
  b.set("B0", "d0", randomExpr(b, "f64", 2));
  // Locals are part of the observable state after a sync; every local slot is compared (see the
  // Python side, which diffs the whole frame).
  b.term("B0", { k: "cbr", c: randomExpr(b, "i32", 1), t: "B1", f: "B2" });

  b.set("B1", "t2", randomExpr(b, "i32", 3));
  b.stmt("B1", { k: "cpuset", field: pick(["eax", "ecx", "edx"]), ty: "i32", v: randomExpr(b, "i32", 2) });
  b.set("B1", "q1", randomExpr(b, "i64", 2));
  b.set("B1", "d1", randomExpr(b, "f64", 2));
  b.term("B1", { k: "switch", idx: randomExpr(b, "i32", 1), targets: ["B3", "B2", "B0", "B3"], dflt: "B2" });

  b.set("B2", "t3", randomExpr(b, "i32", 3));
  // x87 register file only: `ftop` indexes fpr[0..7] (the interpreter models the same).
  b.stmt("B2", { k: "cpuset", field: "fpr", index: c32(ri(8)), ty: "f64", v: randomExpr(b, "f64", 2) });
  b.term("B2", { k: "br", to: "B3" });

  // The random corpus stays acyclic: a random back edge returns to B0, which recomputes the branch
  // condition, so roughly half of the cyclic programs never terminate. Loops are covered on purpose
  // by `loopFunction` below, with a counter that is guaranteed to make progress.
  b.term("B3", { k: "ret" });
  return b.build(`f${index}`);
}

/**
 * A counted loop, the construct the random corpus cannot express: B1 increments a counter and goes
 * back to B0 until it reaches a value taken from guest state, so the trip count is decided at run
 * time. This is what a real lifted function looks like, and it exercises the back edge, the
 * register allocation across a loop and the block labels.
 */
function loopFunction(index) {
  const b = new FuncBuilder(0x500000 + index * 0x100);
  for (const l of I32_LOCALS) b.declare(l);
  for (const bl of ["B0", "B1", "B2"]) b.block(bl);
  // t0 = counter (from ecx), t1 = limit (edx & 0x1f), t2 = accumulator.
  b.set("B0", "t0", cpu("ecx"));
  b.set("B0", "t1", bin("and", cpu("edx"), c32(0x1f)));
  b.set("B0", "t2", cpu("ebx"));
  b.term("B0", { k: "br", to: "B1" });
  b.set("B1", "t2", bin("add", b.declare("t2"), bin("xor", b.declare("t0"), c32(0x9e37))));
  b.set("B1", "t0", bin("add", b.declare("t0"), c32(1)));
  b.term("B1", { k: "cbr", c: bin("ltu", b.declare("t0"), b.declare("t1")), t: "B1", f: "B2" });
  void index;
  b.stmt("B2", { k: "cpuset", field: "eax", ty: "i32", v: b.declare("t2") });
  b.stmt("B2", { k: "cpuset", field: "ecx", ty: "i32", v: b.declare("t0") });
  b.term("B2", { k: "ret" });
  return b.build(`loop${index}`);
}

// ---- Harness host for the interpreter --------------------------------------------------------
function makeHost(mem) {
  const h = {
    mem,
    helper(name) {
      // Only the pure helpers the generator models are expected.
      if (name === "parity8") return 1;
      throw new Error(`unexpected helper ${name}`);
    },
    hle() {
      throw new Error("hle not expected");
    },
    callGuest() {
      throw new Error("guest call not expected");
    },
    trap() {
      throw new Error("trap");
    },
  };
  return h;
}

const failures = [];
let checked = 0;
const CASES = Number(process.env.CASES ?? 120);

const compiled = [];
// Every fifth case is one of the counted loops: the random corpus is acyclic by design (a random
// back edge usually does not terminate), and loops still must be covered.
const cases = [];
for (let i = 0; i < CASES; i++) {
  cases.push(i % 5 === 4 ? loopFunction(i) : randomFunction(i));
}
for (let i = 0; i < cases.length; i++) {
  const f = cases[i];
  let em;
  try {
    em = new Arm64FunctionEmitter(f).emit();
  } catch (err) {
    failures.push(`f${i}: compile error ${err.message}`);
    continue;
  }
  // Initial state, shared by both runs.
  const init = new Uint8Array(MEM_BYTES);
  const cpuOff = 0x8000;
  const c = new DataView(init.buffer);
  for (const g of [...GPR, "ftop", "df", "eflags", "fcw"]) {
    const off = cpuOff + CPU_OFFSET[g];
    const v = g === "fcw" ? 0x7f : u32(ri(0x10000) | (rnd() < 0.1 ? 0x80000000 : 0));
    c.setUint32(off, v, true);
  }
  c.setUint32(cpuOff + CPU_OFFSET.esp, 0x8000);
  for (let k = 0; k < 8; k++) c.setFloat64(cpuOff + CPU_OFFSET.fpr + k * 8, (ri(1000) - 500) / 4);
  // A little data to load from.
  for (let k = 0; k < 256; k++) init[BASE + 0x2000 + k] = ri(256);

  // Reference run.
  const ref = init.slice();
  let refResult;
  const host = makeHost(ref);
  // The compiled code gets the helper effects from the reference run instead of from stubs.
  const events = [];
  host.record = (name, before, after, result) => {
    // Only the bytes a helper changed travel to the Python side: full images would be megabytes.
    const runs = [];
    if (!before || !after) {
      events.push({
        name,
        writes: runs,
        result: result === null ? null : Number(result),
        resultBits: typeof result === "number"
          ? Buffer.from(new Float64Array([result]).buffer).readBigUInt64LE(0).toString()
          : "0",
      });
      return;
    }
    let start = -1;
    for (let i = 0; i < before.length; i++) {
      const differs = before[i] !== after[i];
      if (differs && start < 0) start = i;
      if (!differs && start >= 0) {
        runs.push([start, Buffer.from(after.subarray(start, i)).toString("hex")]);
        start = -1;
      }
    }
    if (start >= 0) runs.push([start, Buffer.from(after.subarray(start)).toString("hex")]);
    events.push({
      name,
      writes: runs,
      result: result === null ? null : Number(result),
      resultBits: typeof result === "number"
        ? Buffer.from(new Float64Array([result]).buffer).readBigUInt64LE(0).toString()
        : "0",
    });
  };
  const machine = new Machine(host);
  try {
    refResult = runFunction(machine, cpuOff, f);
  } catch (err) {
    failures.push(`f${i}: interpreter error ${err.message}`);
    continue;
  }

  // Compiled run.
  const run = init.slice();
  const rc = new DataView(run.buffer);
  rc.setBigUint64(0x9000, 0n); // result slot
  compiled.push({
    index: i,
    name: f.name,
    code: Buffer.from(em.code).toString("hex"),
    calls: em.calls.map((x) => ({ at: x.at, target: x.target })),
    imports: em.imports.map((x) => ({
      at: x.at,
      importIndex: x.importIndex,
      name: RUNTIME_IMPORTS[x.importIndex],
    })),
    tables: em.tables.map((x) => ({ at: x.at, target: x.target })),
    // Only the compared window travels to the runner (Cpu struct + data area); two full images per
    // case would make the JSON unmanageably large for a few hundred cases.
    mem: Buffer.from(run.subarray(0, WINDOW)).toString("hex"),
    events,
    cpu: cpuOff,
    resultSlot: 0x9000,
  });
  // Keep the reference state for comparison in Python.
  (compiled[compiled.length - 1]).refMem = Buffer.from(ref.subarray(0, WINDOW)).toString("hex");
  (compiled[compiled.length - 1]).refEax = refResult >>> 0;
}

if (process.env.DUMP !== undefined) {
  // `DUMP=<index> node arch.test.mjs` prints the IR and the compiled code of one case, for looking
  // at what the generator emitted without running the differential comparison.
  const want = Number(process.env.DUMP);
  const cases = [];
  for (let i = 0; i <= want; i++) cases.push(i % 5 === 4 ? loopFunction(i) : randomFunction(i));
  const f = cases[want];
  const show = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  for (const id of f.order) {
    const b = f.blocks.get(id);
    console.log(`-- ${id}`);
    for (const x of b.stmts) console.log("   " + show(x));
    console.log("   => " + show(b.term));
  }
  const em = new Arm64FunctionEmitter(f).emit();
  const hex = Buffer.from(em.code).toString("hex");
  const dis = execFileSync("python3", [join(import.meta.dirname, "disasm.py"), hex, "0x20000000"], { encoding: "utf8" });
  console.log(dis);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "arch-"));
const file = join(dir, "cases.json");
writeFileSync(file, JSON.stringify(compiled));
try {
  const out = execFileSync("python3", [join(import.meta.dirname, "run-arch.py"), file], { encoding: "utf8", maxBuffer: 1 << 28 });
  process.stdout.write(out);
  if (!out.includes("ok:")) process.exit(1);
} catch (err) {
  process.stdout.write(err.stdout ?? "");
  process.stderr.write(err.stderr ?? "");
  process.exit(1);
}
if (failures.length) {
  console.log(`compile/interpreter failures: ${failures.length}`);
  for (const f of failures.slice(0, 20)) console.log("  " + f);
  process.exit(1);
}
void checked;

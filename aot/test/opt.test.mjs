// Differential test of the IR optimiser.
//
// The point of the passes in aot/src/opt.ts is that they are invisible: a function compiled *after*
// optimisation must end in exactly the same guest state as the same function before it. So this test
// does what arch.test.mjs does -- interpret the IR, then run the compiled machine code in Unicorn and
// compare the whole Cpu struct and a memory window -- twice: once with the optimiser switched off, and
// once with it on. The three runs have to agree, and the optimised code has to be measurably smaller.
//
// Every corpus function is already shaped like lifted x86: a chain of statements that write x86 flags,
// constants folded into address arithmetic, and flag reads only from conditional branches. Cases end
// with a `syncout` so the flag stores the optimiser keeps are actually published (otherwise a late
// dead-store pass would legitimately delete everything the comparison looks at).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Arm64FunctionEmitter } from "../src/arch-arm64.ts";
import { Machine, runFunction, CPU_OFFSET, GPR, RUNTIME_IMPORTS } from "../src/interp.ts";
import { optimise, removeDeadFlags } from "../src/opt.ts";

const MEM_BYTES = 0x100000;
const WINDOW = 0x10000;
const BASE = 0x10000;

let seed = 20260101;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const ri = (n) => Math.floor(rnd() * n);
const pick = (arr) => arr[ri(arr.length)];
const u32 = (x) => x >>> 0;

const c32 = (v) => ({ k: "const", ty: "i32", v: v | 0 });
const loc = (name, ty = "i32") => ({ k: "local", ty, name });
const bin = (op, a, b, ty = a.ty) => ({ k: "bin", op, ty, a, b });
const un = (op, a, ty) => ({ k: "un", op, ty, a });
const load = (bytes, addr, signed = false, ty) => ({ k: "load", ty: ty ?? (bytes === 8 ? "i64" : "i32"), bytes, signed, addr });
const cpu = (field, ty = "i32") => ({ k: "cpu", ty, field });
const sel = (c, a, b) => ({ k: "select", ty: a.ty, c, a, b });

const FLAGS = ["cf", "pf", "af", "zf", "sf", "of"];
const T = ["t0", "t1", "t2", "t3"];

/** A function shaped like lifted x86: arithmetic that sets flags, then a branch on one of them. */
function liftedFunction(index) {
  const blocks = new Map();
  const order = [];
  const block = (id) => {
    if (!blocks.has(id)) {
      blocks.set(id, { id, stmts: [], term: { k: "ret" } });
      order.push(id);
    }
    return blocks.get(id);
  };
  const locals = new Map([...GPR, "ftop", "df", ...FLAGS].map((n) => [n, "i32"]));
  for (const t of T) locals.set(t, "i32");

  const set = (id, name, v) => block(id).stmts.push({ k: "set", name, ty: locals.get(name) ?? "i32", v });

  // Prologue: load the guest registers the body uses out of the Cpu struct.
  for (const r of ["eax", "ebx", "ecx", "edx"]) set("b0", r, cpu(r));

  // Body: a handful of instructions, each writing the flags the way the lifter does (the flag
  // expressions read the operands, so removing a dead store also removes real work).
  const body = [];
  for (let k = 0; k < 4; k++) {
    const lhs = pick(["eax", "ebx", "ecx", "edx", ...T]);
    const rhs = rnd() < 0.4 ? c32(pick([0, 1, -1, 4, 0x100, 0xff])) : loc(pick(["eax", "ebx", "ecx", "edx", ...T]));
    const op = pick(["add", "sub", "add", "and", "xor", "or", "mul"]);
    set("b0", lhs, bin(op, loc(lhs), rhs));
    // cf and of need the operands; zf/sf/pf only need the result. All are cheap, dead ones are not.
    set("b0", "zf", bin("eq", loc(lhs), c32(0)));
    set("b0", "sf", bin("lts", loc(lhs), c32(0)));
    set("b0", "cf", bin("ltu", loc(lhs), rhs));
    set("b0", "of", bin("gts", loc(lhs), c32(0)));
    set("b0", "pf", un("bswap", loc(lhs), "i32"));
    body.push(op);
  }

  // Address arithmetic with constants, plus a load that keeps the result observable. The base is
  // masked into the 1 MiB test window: a random register value must not fault the runner.
  const addr = bin("add", bin("add", bin("and", loc("eax"), c32(0x7ff0)), c32(0x2000)), c32(BASE + (index % 16) * 16));
  set("b0", "t3", load(4, addr));
  set("b0", "t2", bin("xor", loc("t3"), c32(0)));        // identity: folds away
  set("b0", "t1", bin("add", loc("t2"), c32(0)));        // identity: folds away
  set("b0", "t0", sel(c32(1), loc("t1"), c32(7)));       // constant select: folds to t1
  set("b0", "edx", bin("add", loc("edx"), bin("add", c32(0x10), c32(0x20))));
  // Half the cases have a publish/reload pair in the middle of the body, the shape a lifter leaves
  // behind around a call whose target turned out to be a pure helper.
  if (index % 2 === 0) {
    block("b0").stmts.push({ k: "syncout" });
    block("b0").stmts.push({ k: "syncin" });
  }
  block("b0").stmts.push({
    k: "store",
    bytes: 4,
    addr: bin("add", bin("and", loc("ebp"), c32(0x7ff0)), c32(BASE + 0x3000)),
    v: loc("t0"),
  });

  // Branch on a flag that is genuinely live, so the pass cannot delete everything.
  block("b0").term = { k: "cbr", c: bin("ne", loc("zf"), c32(0)), t: "b1", f: "b2" };
  set("b1", "eax", bin("sub", loc("eax"), c32(1)));
  set("b1", "zf", bin("eq", loc("eax"), c32(0)));
  // Every third case branches on a flag *written in the previous block*: a pass that only looks at
  // one block at a time deletes that store and the two runs diverge.
  block("b1").term = index % 3 === 0 ? { k: "cbr", c: bin("ne", loc("cf"), c32(0)), t: "b1a", f: "b1b" } : { k: "br", to: "b3" };
  // The two arms differ in their effect, so the flag really decides the result.
  set("b1a", "eax", bin("add", loc("eax"), c32(1)));
  block("b1a").term = { k: "br", to: "b3" };
  set("b1b", "eax", bin("sub", loc("eax"), c32(1)));
  block("b1b").term = { k: "br", to: "b3" };
  set("b2", "eax", bin("add", loc("eax"), c32(3)));
  set("b2", "zf", bin("eq", loc("eax"), c32(0)));
  block("b2").term = { k: "br", to: "b3" };

  // Both paths publish through the Cpu struct, so the flags they computed are observable state.
  block("b3").stmts.push({ k: "syncout" });
  block("b3").stmts.push({
    k: "store",
    bytes: 4,
    addr: bin("add", bin("and", loc("ebp"), c32(0x7ff0)), c32(BASE + 0x3100)),
    v: loc("eax"),
  });
  block("b3").stmts.push({ k: "syncin" });

  return { entry: 0x401000 + index, name: `f_opt_${index}`, locals, order, blocks };
}

function makeHost(mem) {
  return {
    mem,
    helper(name) {
      if (name === "parity8") return 1;
      throw new Error(`unexpected helper ${name}`);
    },
    hle() { throw new Error("hle not expected"); },
    callGuest() { throw new Error("guest call not expected"); },
    trap() { throw new Error("trap"); },
  };
}

const CASES = Number(process.env.CASES ?? 60);
const failures = [];
const cases = [];
const compiled = [];
let baselineBytes = 0;
let optimisedBytes = 0;
let foldedTotal = 0;
let flagsTotal = 0;
let syncsTotal = 0;

for (let i = 0; i < CASES; i++) {
  const f = liftedFunction(i);
  const opt = optimise(f).functions;
  const base = new Arm64FunctionEmitter(f).emit();
  let em;
  try {
    em = new Arm64FunctionEmitter(opt).emit();
  } catch (err) {
    failures.push(`f${i}: optimised compile error ${err.message}`);
    continue;
  }
  const again = optimise(f);
  foldedTotal += again.folded;
  flagsTotal += again.flagsRemoved;
  syncsTotal += again.syncsRemoved;
  baselineBytes += base.code.length;
  optimisedBytes += em.code.length;

  const init = new Uint8Array(MEM_BYTES);
  const cpuOff = 0x8000;
  const c = new DataView(init.buffer);
  for (const g of [...GPR, "ftop", "df", "eflags", "fcw"]) {
    const v = g === "fcw" ? 0x7f : u32(ri(0x10000) | (rnd() < 0.1 ? 0x80000000 : 0));
    c.setUint32(cpuOff + CPU_OFFSET[g], v, true);
  }
  c.setUint32(cpuOff + CPU_OFFSET.esp, 0x8000);
  for (let k = 0; k < 512; k++) init[BASE + 0x2000 + k] = ri(256);

  // Reference: the interpreter on the unoptimised IR (the optimiser must not change semantics).
  const refMem = init.slice();
  let ref;
  const machine = new Machine(makeHost(refMem));
  try {
    ref = runFunction(machine, cpuOff, f);
  } catch (err) {
    failures.push(`f${i}: interpreter error ${err.message}`);
    continue;
  }

  // Sanity: the optimised IR interpreted must agree with the unoptimised one, independently of codegen.
  const optMem = init.slice();
  const optMachine = new Machine(makeHost(optMem));
  try {
    runFunction(optMachine, cpuOff, opt);
  } catch (err) {
    failures.push(`f${i}: optimised interpreter error ${err.message}`);
    continue;
  }
  for (let k = 0; k < WINDOW; k++) {
    if (optMem[k] !== refMem[k]) {
      failures.push(`f${i}: optimised IR disagrees at byte 0x${k.toString(16)}`);
      break;
    }
  }

  // Compiled run of the optimised function.
  const run = init.slice();
  const rc = new DataView(run.buffer);
  rc.setBigUint64(0x9000, 0n);
  compiled.push({
    index: i,
    name: opt.name,
    code: Buffer.from(em.code).toString("hex"),
    calls: em.calls.map((x) => ({ at: x.at, target: x.target })),
    imports: em.imports.map((x) => ({ at: x.at, importIndex: x.importIndex, name: RUNTIME_IMPORTS[x.importIndex] })),
    tables: em.tables.map((x) => ({ at: x.at, target: x.target })),
    mem: Buffer.from(run.subarray(0, WINDOW)).toString("hex"),
    events: [],
    cpu: cpuOff,
    resultSlot: 0x9000,
    /** The state the interpreter reached: what the machine code has to reproduce. */
    refMem: Buffer.from(refMem.subarray(0, WINDOW)).toString("hex"),
  });
  cases.push({ i, ref });
}

if (failures.length) {
  console.log(`optimiser failures: ${failures.length}`);
  for (const f of failures.slice(0, 20)) console.log("  " + f);
  process.exit(1);
}

// Sanity check of the analysis itself: a flag written in one block and read in a later one has to
// survive, or the pass is only looking inside single blocks. This is the mistake that produces code
// which is wrong exactly on the flags a loop condition reads.
{
  const blocks = new Map([
    ["b0", { id: "b0", stmts: [{ k: "set", name: "zf", ty: "i32", v: c32(0) }], term: { k: "br", to: "b1" } }],
    ["b1", { id: "b1", stmts: [], term: { k: "cbr", c: bin("ne", loc("zf"), c32(0)), t: "b2", f: "b2" } }],
    ["b2", { id: "b2", stmts: [], term: { k: "ret" } }],
  ]);
  const locals = new Map([["zf", "i32"]]);
  const out = removeDeadFlags({ entry: 0x1000, name: "chain", locals, order: ["b0", "b1", "b2"], blocks }).functions;
  if (!out.blocks.get("b0").stmts.some((s) => s.k === "set" && s.name === "zf")) {
    console.log("opt: a flag written in one block and read in its successor was removed (the analysis is block-local)");
    process.exit(1);
  }
}

const dir = mkdtempSync(join(tmpdir(), "opt-"));
const file = join(dir, "cases.json");
writeFileSync(file, JSON.stringify(compiled));
let out = "";
try {
  out = execFileSync("python3", [join(import.meta.dirname, "run-opt.py"), file], { encoding: "utf8", maxBuffer: 1 << 28 });
  process.stdout.write(out);
} catch (err) {
  process.stdout.write(err.stdout ?? "");
  process.stderr.write(err.stderr ?? "");
  process.exit(1);
}
if (!out.includes("ok:")) process.exit(1);

// The optimiser has to actually do something: a pass that silently stopped matching would keep the
// test green while the port paid for it on every device.
const shrink = baselineBytes ? (1 - optimisedBytes / baselineBytes) * 100 : 0;
console.log(
  `opt: ${CASES} functions, ${foldedTotal} constant folds, ${flagsTotal} dead flag stores, ${syncsTotal} redundant syncs, ` +
  `${baselineBytes} -> ${optimisedBytes} bytes (${shrink.toFixed(1)}% smaller)`,
);
if (flagsTotal === 0 || foldedTotal === 0 || syncsTotal === 0) {
  console.log("opt: the passes did not fire on this corpus");
  process.exit(1);
}

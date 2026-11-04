// Module test: compile several IR functions into one image, map it the way the device loader does,
// and run the result in Unicorn.
//
// This covers what the per-function test cannot: that guest-to-guest calls land on the right
// function, that imports resolve to distinct addresses, and that the loader's relocations and jump
// tables produce an image that behaves exactly like the reference interpreter.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModule, parseModule, relocate } from "../src/module.ts";
import { Arm64FunctionEmitter } from "../src/arch-arm64.ts";
import { Machine, runFunction, CPU_OFFSET, GPR, RUNTIME_IMPORTS } from "../src/interp.ts";

const MEM_BYTES = 0x100000;
const WINDOW = 0x10000;
const CODE_ADDRESS = 0x20000000n;
const IMPORT_ADDRESS = 0x21000000n;
const FUNCTION_THUNK = 0x22000000n;
const RESULT_SLOT = 0x9000;
const CPU_OFFSET_IN_MEM = 0x8000;

// ---- IR builders -------------------------------------------------------------------------------

/** Local variable / expression helpers, so the programs below stay readable. */
const local = (name, ty = "i32") => ({ k: "local", ty, name });
const constant = (v, ty = "i32") => ({ k: "const", ty, v });
const cpuReg = (field) => ({ k: "cpu", ty: "i32", field });
const bin = (op, a, b, ty = "i32") => ({ k: "bin", op, ty, a, b });
const un = (op, a, ty = "i32") => ({ k: "un", op, ty, a });
const load = (addr, ty = "i32", bytes = 4, signed = false) => ({ k: "load", ty, bytes, signed, addr });
const store = (addr, value, bytes = 4) => ({ k: "store", bytes, addr, v: value });
const storeConst = (addr, value, bytes = 4) => ({ k: "store", bytes, addr: constant(addr), v: value });

/**
 * Wrap block bodies into an `IrFunc`. Locals are discovered from the IR itself (every `local` and
 * `set` names one), which keeps the programs below free of bookkeeping while still matching the
 * recompiler's contract: guest registers and `ftop`/`df` are locals like any other.
 */
function func(entry, name, blocks) {
  const locals = new Map();
  for (const g of [...GPR, "ftop", "df"]) locals.set(g, "i32");
  const visit = (node, ty) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return void node.forEach((x) => visit(x));
    if (node.k === "local") return void locals.set(node.name, node.ty);
    if (node.k === "set") locals.set(node.name, node.ty);
    if (node.field !== undefined && node.k === "cpu") {
      locals.set(node.field, node.ty === "f64" ? "i32" : node.ty);
    }
    for (const v of Object.values(node)) visit(v, ty);
  };
  for (const b of Object.values(blocks)) {
    b.stmts.forEach((st) => visit(st));
    visit(b.term);
  }
  return { entry, name, locals, blocks: new Map(Object.entries(blocks)), order: Object.keys(blocks) };
}

/**
 * Program under test. `f0` is entered first; it calls `f1` and `f2` through `rt_dispatch`
 * (`callguest`), reads and writes guest memory, and uses both a switch and a counted loop inside
 * `f1` so the module's jump tables and back edges are exercised.
 */
function program() {
  const blocks = {
    B0: {
      stmts: [
        { k: "set", name: "t0", ty: "i32", v: cpuReg("ecx") },
        // x = mem32[0x4000 + (t0 & 0x7f) * 4]
        {
          k: "set",
          name: "t1",
          ty: "i32",
          v: load(bin("add", constant(0x4000), bin("mul", bin("and", local("t0"), constant(0x7f)), constant(4)))),
        },
        // call f1(guest 0x401001) — its eax lands in the Cpu struct and is read back here.
        { k: "callguest", target: 0x401001 },
      ],
      term: { k: "cbr", c: bin("lts", local("t1"), constant(0)), t: "B1", f: "B2" },
    },
    B1: {
      stmts: [
        { k: "cpuset", field: "eax", ty: "i32", v: bin("add", local("t1"), cpuReg("eax")) },
        { k: "callguest", target: 0x401002 },
        { k: "set", name: "t2", ty: "i32", v: bin("sub", cpuReg("eax"), local("t1")) },
        storeConst(0x5000, local("t2")),
      ],
      term: { k: "br", to: "B3" },
    },
    B2: {
      stmts: [
        { k: "callguest", target: 0x401002 },
        { k: "cpuset", field: "edx", ty: "i32", v: bin("xor", cpuReg("eax"), local("t1")) },
        storeConst(0x5004, cpuReg("edx")),
      ],
      // No edge back to B0: the program under test must terminate, and a random back edge would
      // leave the interpreter spinning until its basic-block limit.
      term: { k: "switch", idx: bin("and", local("t0"), constant(3)), targets: ["B3", "B1", "B3", "B3"], dflt: "B3" },
    },
    B3: { stmts: [{ k: "cpuset", field: "ebx", ty: "i32", v: bin("add", local("t0"), constant(1)) }], term: { k: "ret" } },
  };
  return func(0x401000, "f0", blocks);
}

/** A counted loop plus a switch: the module must patch its own jump tables. */
function callee1() {
  const blocks = {
    B0: {
      stmts: [
        { k: "set", name: "t0", ty: "i32", v: cpuReg("esi") },
        { k: "set", name: "t1", ty: "i32", v: bin("and", cpuReg("edi"), constant(0x0f)) },
        { k: "set", name: "t2", ty: "i32", v: cpuReg("eax") },
      ],
      term: { k: "br", to: "B1" },
    },
    B1: {
      stmts: [
        { k: "set", name: "t2", ty: "i32", v: bin("add", local("t2"), bin("xor", local("t0"), constant(0x51ed))) },
        { k: "set", name: "t0", ty: "i32", v: bin("add", local("t0"), constant(1)) },
      ],
      term: { k: "cbr", c: bin("ltu", local("t0"), local("t1")), t: "B1", f: "B2" },
    },
    B2: {
      stmts: [],
      term: { k: "switch", idx: bin("and", local("t2"), constant(3)), targets: ["B4", "B3", "B4", "B4"], dflt: "B4" },
    },
    B3: { stmts: [{ k: "set", name: "t2", ty: "i32", v: bin("add", local("t2"), constant(7)) }], term: { k: "br", to: "B4" } },
    B4: {
      stmts: [
        { k: "cpuset", field: "eax", ty: "i32", v: local("t2") },
        // memory round-trip through a helper-visible address
        storeConst(0x6000, local("t2")),
        { k: "cpuset", field: "esi", ty: "i32", v: load(constant(0x6000)) },
      ],
      term: { k: "ret" },
    },
  };
  return func(0x401001, "f1", blocks);
}

/**
 * Uses a runtime import (`rt_cpuid`, which the lifter emits for the CPUID instruction surrounded by
 * `syncout`/`syncin`), so the loader has to bind an import relocation to a distinct address.
 * Helpers that return values in x0/d0 are covered by `arch.test.mjs`; here the point is that the
 * import slot is resolved and that register state crosses the boundary through the Cpu struct.
 */
function callee2() {
  const blocks = {
    B0: {
      stmts: [
        { k: "syncout" },
        { k: "helper", fn: "rt_cpuid", args: [] },
        { k: "syncin" },
        { k: "cpuset", field: "eax", ty: "i32", v: bin("add", cpuReg("eax"), cpuReg("ebx")) },
      ],
      term: { k: "ret" },
    },
  };
  return func(0x401002, "f2", blocks);
}

// ---- Harness -----------------------------------------------------------------------------------

function makeHost(mem) {
  return {
    mem,
    helper() {
      throw new Error("helper not expected outside the runtime import table");
    },
    hle() {
      throw new Error("hle not expected");
    },
    callGuest() {
      throw new Error("the module test does not follow guest calls from the interpreter");
    },
    trap() {
      throw new Error("trap");
    },
  };
}

let seed = 987654321;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const ri = (n) => Math.floor(rnd() * n);

const failures = [];
const compiled = [];

const funcs = [program(), callee1(), callee2()];
const payload = new Map();
for (const f of funcs) {
  const em = new Arm64FunctionEmitter(f).emit();
  payload.set(f.entry, em);
}
const mod = buildModule([...payload.values()]);
const parsed = parseModule(mod.bytes);
if (parsed.entries.length !== 3) failures.push(`module has ${parsed.entries.length} entries, want 3`);

// The interpreter runs each function on its own: guest calls become "call this other function".
for (let i = 0; i < 24; i++) {
  const init = new Uint8Array(MEM_BYTES);
  const dv = new DataView(init.buffer);
  for (const g of [...GPR, "ftop", "df", "eflags", "fcw"]) {
    const off = CPU_OFFSET_IN_MEM + CPU_OFFSET[g];
    dv.setUint32(off, g === "fcw" ? 0x7f : (ri(0x10000) | (rnd() < 0.1 ? 0x80000000 : 0)) >>> 0, true);
  }
  dv.setUint32(CPU_OFFSET_IN_MEM + CPU_OFFSET.esp, 0x8000, true);
  dv.setFloat64(CPU_OFFSET_IN_MEM + CPU_OFFSET.fpr + 8, (ri(2000) - 1000) / 8);
  dv.setFloat64(CPU_OFFSET_IN_MEM + CPU_OFFSET.fpr + 16, (ri(2000) - 1000) / 8);
  for (let k = 0; k < 256; k++) init[0x4000 + k] = ri(256);

  const ref = init.slice();
  const machine = new Machine(makeHost(ref));
  const events = [];
  machine.host.record = (name, before, after, result) => {
    const writes = [];
    if (before && after) {
      let start = -1;
      for (let j = 0; j < before.length; j++) {
        const differs = before[j] !== after[j];
        if (differs && start < 0) start = j;
        if (!differs && start >= 0) {
          writes.push([start, Buffer.from(after.subarray(start, j)).toString("hex")]);
          start = -1;
        }
      }
      if (start >= 0) writes.push([start, Buffer.from(after.subarray(start)).toString("hex")]);
    }
    events.push({
      name,
      writes,
      result: result === null ? null : Number(result),
      resultBits: typeof result === "number"
        ? Buffer.from(new Float64Array([result]).buffer).readBigUInt64LE(0).toString()
        : "0",
    });
  };
  // Guest calls inside the interpreter run the callee on the same machine, like the device: the
  // register state travels through the Cpu struct, exactly as `syncout`/`syncin` describe.
  const byEntry = new Map(funcs.map((f) => [f.entry, f]));
  machine.host.callGuest = (target) => {
    const callee = byEntry.get(target);
    if (!callee) throw new Error(`no such function 0x${target.toString(16)}`);
    runFunction(machine, CPU_OFFSET_IN_MEM, callee);
  };
  try {
    runFunction(machine, CPU_OFFSET_IN_MEM, byEntry.get(0x401000));
  } catch (err) {
    failures.push(`case ${i}: interpreter error ${err.message}`);
    continue;
  }

  const run = init.slice();
  compiled.push({
    index: i,
    // Only the window that is compared travels to the runner.
    mem: Buffer.from(run.subarray(0, WINDOW)).toString("hex"),
    refMem: Buffer.from(ref.subarray(0, WINDOW)).toString("hex"),
    events,
    cpu: CPU_OFFSET_IN_MEM,
    image: Buffer.from(mod.bytes).toString("hex"),
  });
}

if (!compiled.length) {
  console.log("FAILURES (no cases could be prepared)");
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "module-"));
const file = join(dir, "cases.json");
writeFileSync(file, JSON.stringify({
  codeAddress: `0x${CODE_ADDRESS.toString(16)}`,
  importAddress: `0x${IMPORT_ADDRESS.toString(16)}`,
  thunkAddress: `0x${FUNCTION_THUNK.toString(16)}`,
  // The loader needs to know where each function starts; on the device this comes from the cache
  // manifest written next to the image (the image itself stores entries, not function sizes).
  offsets: Object.fromEntries([...mod.offsets].map(([k, v]) => [String(k), v])),
  cases: compiled,
}));
try {
  const out = execFileSync("python3", [join(import.meta.dirname, "run-module.py"), file], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  process.stdout.write(out);
  if (!out.includes("ok:")) process.exit(1);
} catch (err) {
  process.stdout.write(err.stdout ?? "");
  process.stderr.write(err.stderr ?? "");
  process.exit(1);
}
if (failures.length) {
  console.log(`compile/interpreter failures: ${failures.length}`);
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
void RUNTIME_IMPORTS;

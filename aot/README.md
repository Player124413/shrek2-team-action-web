# `aot/` — on-device ARM64 compiler for the translated game

The desktop site translates the game's x86 program to WebAssembly in the browser. The Android port
keeps that translation (it is the same, verified front end in `recomp/`) but does **not** interpret
the result: `aot/` compiles the same translated IR directly to **AArch64 machine code** on the
phone, so the game's own code runs natively at full speed — the "native port" the launcher offers.

```
Shrek 2.exe --recomp/--> IR --aot/--> ARM64 machine code --mmap(PROT_EXEC)--> native CPU
                          |
                          +--(browser)--> WebAssembly
```

* `src/arm64.ts` — instruction encoder + one-pass assembler (branch/literal fixups).
* `src/arch-arm64.ts` — IR → ARM64: register allocation over the callee-saved registers, stack
  spill slots, structured-free basic-block emission (real branches, jump tables), and the runtime
  ABI the C++ side expects (`void f(Cpu*)`).
* `src/opt.ts` — the IR optimisation passes the image build runs before code generation: constant
  folding (including the identities the lifter emits: `+0`, `^0`, `&-1`, `*1`, shifts by zero, selects
  with constant arms), **dead x86 flag stores** (a dataflow pass: the lifter writes `cf/pf/af/zf/sf/of`
  after every arithmetic instruction, and the next consumer is usually far away and overwritten first —
  the expression behind a dead store is where the carry/parity/overflow computation lives, so removing
  the store removes that work too), and adjacent `syncout`/`syncin` pairs, which publish and reload the
  same register values.
* `src/module.ts` — module container and loader. Concatenates compiled functions into one
  relocatable image (header, entry table, code, relocation table, jump-table list) and resolves it
  when it is mapped: runtime imports become C function pointers, guest calls become addresses inside
  the same image. The same relocation path is used on the device and in the tests.
* `test/` — differential verification, all of it against the same reference interpreter
  (`src/interp.ts`) that the WebAssembly backend is checked with:
  * `enc.test.mjs` assembles thousands of instruction cases and executes them in Unicorn (ARM64),
    comparing every register and memory word;
  * `arch.test.mjs` compiles random IR functions (plus explicit counted loops) and runs them in
    Unicorn, comparing the whole `Cpu` struct and a memory window;
  * `module.test.mjs` builds a module out of three functions, maps it at an address it was not built
    for, relocates it and runs it, so guest calls, imports and jump tables are checked through the
    loader rather than in isolation;
  * `opt.test.mjs` compiles functions shaped like lifted x86 *twice* — with and without the optimiser —
    interprets both, and runs the optimised machine code in Unicorn, so a pass that deletes something
    live shows up as a state mismatch. It also asserts that each pass actually fires, that the code got
    smaller, and that a flag written in one block and read in its successor survives (the mistake that
    would break every loop condition).

  Runtime helpers are never stubbed: the interpreter records the memory delta and the result of
  every helper call and the runner replays them, so a mismatch can only come from the code
  generator or the loader.

Run `node aot/test/enc.test.mjs`, `node aot/test/arch.test.mjs`, `node aot/test/module.test.mjs` and
`node aot/test/opt.test.mjs` (needs `python3 -m pip install unicorn capstone`). `CASES=<n>` sets how many random functions
`arch.test.mjs` generates; `DUMP=<index>` prints the IR and the compiled code of one case.

## Building an image

`cli.ts` is what the Android build calls. It lifts every function of the executable's front end to IR,
compiles it, and writes the three files the APK carries:

```sh
node aot/cli.ts image "/path/to/Shrek 2.exe" --meta metadata/<sha256>.json --out work/aot
node aot/cli.ts check work/aot
```

* `game.sk2a` — the relocatable image (format above);
* `game.skx` — the side table the loader needs: `guestAddress codeOffset` per function (the image does
  not store function sizes), then one trap message per line in image-wide id order;
* `aot.txt` — a one-line summary.

The image build runs `optimise()` from `src/opt.ts` on every function before it is compiled; on the
test corpus that is ~44% fewer bytes of machine code for the same behaviour (constant folds, dead flag
stores, redundant syncs), and the dead flag stores also remove the carry/parity computation behind
them at run time.

Trap ids are shared by the whole image (`new Arm64FunctionEmitter(fn, shared)`), because the runtime
receives a bare integer from `rt_trap_id`.

The loader on the other side is `android/app/src/main/cpp/aot_module.cpp`; the two halves of the
format have to change together, and `aot/cli.ts check` validates the bounds the loader enforces.

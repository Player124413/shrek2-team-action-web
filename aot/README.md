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
    loader rather than in isolation.

  Runtime helpers are never stubbed: the interpreter records the memory delta and the result of
  every helper call and the runner replays them, so a mismatch can only come from the code
  generator or the loader.

Run `node aot/test/enc.test.mjs`, `node aot/test/arch.test.mjs` and `node aot/test/module.test.mjs`
(needs `python3 -m pip install unicorn capstone`). `CASES=<n>` sets how many random functions
`arch.test.mjs` generates; `DUMP=<index>` prints the IR and the compiled code of one case.

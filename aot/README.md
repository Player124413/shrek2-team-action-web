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
* `src/module.ts` — module container: function table (guest address → code offset), trap strings,
  and the fixed header the runtime loads.
* `test/` — differential verification. `enc.test.mjs` assembles thousands of instruction cases and
  executes them in Unicorn (ARM64), comparing every register and memory word;
  `arch.test.mjs` compiles random IR functions and runs them both in Unicorn (compiled) and
  against a reference IR interpreter, comparing the resulting CPU state and memory.

Run `node aot/test/enc.test.mjs` and `node aot/test/arch.test.mjs` (needs `python3 -m pip install
unicorn capstone`).

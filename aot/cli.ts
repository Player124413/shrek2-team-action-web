/**
 * Builds the on-device AOT image for the Android port.
 *
 *   node aot/cli.ts image <exe> --meta metadata/<sha256>.json --out <dir>
 *   node aot/cli.ts check <dir>
 *
 * The output directory receives what `android/` ships inside the APK:
 *
 *   game.sk2a   the relocatable ARM64 image (see src/module.ts for the format)
 *   game.skx    the side table the loader needs: guest address -> code offset, then trap messages
 *   aot.txt     a one-line summary the launcher shows ("N functions, M bytes of code")
 *
 * `check` re-reads both files, applies the loader's bounds rules and reports the function count, so a
 * broken image is caught on the build machine rather than on the phone.
 *
 * The image is built from the user's own executable and lives in work/ or in a locally built APK; it
 * is never committed.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Arm64FunctionEmitter } from "./src/arch-arm64.ts";
import type { FunctionCode } from "./src/arch-arm64.ts";
import { RUNTIME_IMPORTS } from "./src/interp.ts";
import { buildModule, parseModule } from "./src/module.ts";
import { Program } from "../recomp/src/cfg.ts";
import { liftFunction } from "../recomp/src/lift.ts";
import { PeImage } from "../recomp/src/pe.ts";

export const SIDE_VERSION = 1;

/** Address-level metadata produced by `recomp/src/cli.ts metadata` (see metadata/<sha256>.json). */
interface Metadata {
  format: 1;
  exe: { name: string; sha256: string; size: number };
  entries: number[];
  noreturn: number[];
  jumpTargets: [number, number[]][];
}

export const SIDE_HEADER = `# shrek2 AOT v${SIDE_VERSION}`;
const TRAP_MARKER = "# traps";

/** The side table: the offsets the image cannot carry, plus trap messages in image-wide id order. */
export function formatSideTable(built: { entries: number[]; offsets: Map<number, number> }, traps: string[]): string {
  const lines = [SIDE_HEADER, "# guestAddress codeOffset"];
  for (const e of built.entries) lines.push(`${e.toString(16)} ${built.offsets.get(e)!.toString(16)}`);
  lines.push(TRAP_MARKER);
  // A message can contain anything the IR wanted to say; newlines would break the one-per-line file.
  for (const m of traps) lines.push(`!${m.replace(/[\r\n]+/g, " ")}`);
  return lines.join("\n") + "\n";
}

export interface SideTable {
  offsets: Map<number, number>;
  traps: string[];
}

export function parseSideTable(text: string): SideTable {
  const offsets = new Map<number, number>();
  const traps: string[] = [];
  let inTraps = false;
  for (const line of text.split("\n")) {
    if (line === SIDE_HEADER) continue;
    if (line === TRAP_MARKER) {
      inTraps = true;
      continue;
    }
    if (line.startsWith("#")) continue;
    if (inTraps) {
      if (line.startsWith("!")) traps.push(line.slice(1));
      continue;
    }
    const m = /^([0-9a-f]+) ([0-9a-f]+)$/.exec(line);
    if (m) offsets.set(parseInt(m[1], 16), parseInt(m[2], 16));
  }
  return { offsets, traps };
}

/** Compile every function of the executable into one image plus its side table. */
export function buildImage(exe: Uint8Array, meta?: Metadata): { image: Uint8Array; side: string; functions: number } {
  const pe = new PeImage(exe);
  const prog = new Program(pe, {
    entries: meta?.entries,
    noreturn: meta?.noreturn,
    jumpTargets: new Map(meta?.jumpTargets),
  });
  // With a complete entry list from the metadata the front end never has to speculate.
  prog.discover({ speculate: !meta });
  const importIndex = new Map(pe.imports.map((im, i) => [im.iatSlot, i]));

  const entries = [...prog.funcs.keys()].sort((a, b) => a - b);
  // One trap table for the whole image: `rt_trap_id` takes a bare integer id, so the id a function
  // was compiled with must mean the same thing in every other function.
  const shared = { traps: [] as string[] };
  const compiled: FunctionCode[] = entries.map((entry) => {
    const fn = liftFunction(prog, prog.funcs.get(entry)!, (slot) => importIndex.get(slot)!);
    return new Arm64FunctionEmitter(fn, shared).emit();
  });
  // `buildModule` takes already-emitted functions: the emitters above share one trap table.
  const built = buildModule(compiled, { importNames: RUNTIME_IMPORTS });
  return { image: built.bytes, side: formatSideTable(built, shared.traps), functions: built.functions };
}

const main = (): void => {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };

  if (cmd === "image") {
    const exePath = args[1];
    if (!exePath) throw new Error("usage: node aot/cli.ts image <exe> [--meta <metadata.json>] --out <dir>");
    const metaPath = opt("--meta");
    const meta = metaPath ? (JSON.parse(readFileSync(metaPath, "utf8")) as Metadata) : undefined;
    const exe = new Uint8Array(readFileSync(exePath));
    const sha = createHash("sha256").update(exe).digest("hex");
    if (meta && sha !== meta.exe.sha256) throw new Error(`executable ${sha} does not match metadata ${meta.exe.sha256}`);
    const t0 = performance.now();
    const { image, side, functions } = buildImage(exe, meta);
    const out = opt("--out") ?? "work/aot";
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "game.sk2a"), image);
    writeFileSync(join(out, "game.skx"), side);
    writeFileSync(join(out, "aot.txt"), `${functions} functions, ${image.length} bytes\n`);
    console.log(`[${sha.slice(0, 12)}] ${functions} functions in ${((performance.now() - t0) / 1000).toFixed(1)} s: ` +
      `${(image.length / 1048576).toFixed(1)} MB image -> ${out}`);
    process.exit(0);
  }

  if (cmd === "check") {
    const dir = args[1] ?? "work/aot";
    const mod = parseModule(new Uint8Array(readFileSync(join(dir, "game.sk2a"))));
    const side = parseSideTable(readFileSync(join(dir, "game.skx"), "utf8"));
    if (side.offsets.size !== mod.entries.length) {
      throw new Error(`side table lists ${side.offsets.size} functions, the image has ${mod.entries.length}`);
    }
    for (const e of mod.entries) {
      const off = side.offsets.get(e);
      if (off === undefined) throw new Error(`guest function ${e.toString(16)} has no code offset`);
      if (off + 4 > mod.code.length) throw new Error(`guest function ${e.toString(16)} starts past the code section`);
    }
    for (const r of mod.relocs) {
      // movz/movk sequences occupy 16 bytes; a jump-table entry is a single 8-byte slot.
      if (r.at + (r.kind === "table" ? 8 : 16) > mod.code.length) {
        throw new Error(`relocation at ${r.at} (${r.kind}) runs past the code section`);
      }
      if (r.kind === "import" && Number(r.addend) >= RUNTIME_IMPORTS.length) {
        throw new Error(`import index ${r.addend} is not one of the ${RUNTIME_IMPORTS.length} runtime imports`);
      }
    }
    console.log(`ok: ${mod.entries.length} functions, ${mod.code.length} bytes of code, ${mod.relocs.length} relocations, ` +
      `${side.traps.length} traps`);
    process.exit(0);
  }

  console.error("usage: node aot/cli.ts image <exe> [--meta metadata/<sha>.json] --out <dir> | check <dir>");
  process.exit(2);
};

main();

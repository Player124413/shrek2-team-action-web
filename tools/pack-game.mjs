/**
 * Packages an installed copy of the game into the APK.
 *
 *   node tools/pack-game.mjs --from-dir <installed folder> --out <assets dir>
 *   node tools/pack-game.mjs --from-iso <disc.iso>        --out <assets dir>
 *
 * The launcher can install from the player's own disc image, which needs the disc. Building the game into
 * the APK is the other half: the player installs the APK and starts the game, with nothing to copy.
 *
 * What it writes:
 *   game/Game/...        the installed trees, byte for byte (`Game/Shrek 2.exe`, `Game/Chars/...`)
 *   game/index.txt       one `size<TAB>path` line per file, in install order
 *   game/stamp.txt       `<folder md5> <files> <bytes>`: what the launcher compares to decide whether to
 *                        unpack again (the game files survive an update, the APK's copy may have changed)
 *   game/manifest.json   the contract: file count, total size, folder MD5, and the MD5 of each file
 *
 * The game is *not* in the repository and must not be: an APK that ships it is for the person who owns
 * the game, built on their machine or in their CI from a secret. `--from-iso` runs the reference installer
 * (installer/src) over a disc image, so the packaged tree is exactly what the installer would write.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const out = arg("--out") ?? "android/app/src/main/assets";
const fromDir = arg("--from-dir");
const fromIso = arg("--from-iso");
if (!fromDir && !fromIso) {
  console.error("usage: node tools/pack-game.mjs (--from-dir <installed folder> | --from-iso <disc.iso>) --out <assets dir>");
  process.exit(2);
}

const md5 = (buf) => createHash("md5").update(buf).digest("hex");

/** The tree to package: either the folder as it is, or what the reference installer writes out of a disc. */
let sourceDir = fromDir;
let staged = false;
if (fromIso) {
  if (!existsSync(fromIso)) {
    console.error(`no disc image at ${fromIso}`);
    process.exit(2);
  }
  sourceDir = join(out, ".game-from-iso");
  rmSync(sourceDir, { recursive: true, force: true });
  mkdirSync(sourceDir, { recursive: true });
  staged = true;
  const { install } = await import("../installer/src/install.ts");
  const { DirSink, NodeFileSource } = await import("../installer/src/node.ts");
  const src = new NodeFileSource(fromIso);
  let last = 0;
  const report = await install(src, new DirSink(sourceDir), {
    verify: true,
    onProgress: (p) => {
      const now = performance.now();
      if (now - last > 2000 || p.phase === "done") {
        last = now;
        process.stderr.write(`\r${p.phase} ${p.done}/${p.total} ${p.path ?? ""}`.padEnd(90).slice(0, 90));
      }
    },
  });
  src.close();
  process.stderr.write("\n");
  if (report.mismatches.length) {
    console.error(`${report.mismatches.length} files did not verify; refusing to package a damaged tree`);
    for (const m of report.mismatches.slice(0, 10)) console.error(`  ${m}`);
    process.exit(1);
  }
  console.log(`installed ${report.written} files (${(report.bytes / 1e6).toFixed(1)} MB) from volume ${report.volumeId}`);
} else if (!existsSync(join(sourceDir, "Game"))) {
  console.error(`${sourceDir} does not look like an installed copy: expected ${join(sourceDir, "Game")}`);
  process.exit(2);
}

// The executable is the one file the game cannot start without; check it before writing 500 MB into assets.
const exePath = join(sourceDir, "Game", "Shrek 2.exe");
if (!existsSync(exePath)) {
  console.error(`no Game/Shrek 2.exe in ${sourceDir}: that folder is not an installed copy of the game`);
  process.exit(2);
}

const tree = join(out, "game");
rmSync(tree, { recursive: true, force: true });
mkdirSync(tree, { recursive: true });

/** The packer's own files at the root of a tree; skipped so packing a packed tree is idempotent. */
const OWN = new Set(["index.txt", "manifest.json", "stamp.txt"]);

/** Every file under `dir`, as forward-slash paths relative to it, in a stable (sorted) order. */
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relative(base, full).split("\\").join("/");
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === ".game-from-iso") continue;
      walk(full, base, out);
    } else if (st.isFile()) {
      if (!rel.includes("/") && OWN.has(name)) continue;
      out.push(rel);
    }
  }
  return out;
}

const files = walk(sourceDir);
if (files.length === 0) {
  console.error(`nothing to package in ${sourceDir}`);
  process.exit(2);
}

const index = [];
const manifest = { files: [], folderMd5: "", bytes: 0 };
// The folder hash is over `md5<TAB>size<TAB>path` lines: a single value that says "this is the same tree",
// used by the launcher's check and by CI to prove the APK carries what was built.
const folderHash = createHash("md5");
for (const rel of files) {
  const from = join(sourceDir, rel);
  const data = readFileSync(from);
  const digest = md5(data);
  const to = join(tree, rel);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, data);
  index.push(`${data.length}\t${rel}`);
  manifest.files.push({ path: rel, size: data.length, md5: digest });
  manifest.bytes += data.length;
  folderHash.update(`${digest}\t${data.length}\t${rel.toLowerCase()}\n`);
}
manifest.folderMd5 = folderHash.digest("hex");

writeFileSync(join(tree, "index.txt"), index.join("\n") + "\n");
// One short file the app reads on start-up to decide whether its installed copy is the one this APK
// carries. Keeping it tiny matters: it is opened on every launch.
writeFileSync(join(tree, "stamp.txt"), `${manifest.folderMd5} ${files.length} ${manifest.bytes}\n`);
writeFileSync(join(tree, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
if (staged) rmSync(sourceDir, { recursive: true, force: true });

const mb = (manifest.bytes / 1e6).toFixed(1);
console.log(`ok: packaged ${files.length} files (${mb} MB) into ${tree}`);
console.log(`    folder md5 ${manifest.folderMd5}`);
console.log(`    first: ${manifest.files[0].path}; largest: ${manifest.files.reduce((a, b) => (b.size > a.size ? b : a)).path}`);

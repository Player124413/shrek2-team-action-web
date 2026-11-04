#!/bin/sh
# Checks the disc installer twice over: the TypeScript implementation the web build uses, and the Kotlin
# port that ships in the APK.
#
#   tools/installer-test.sh [--keep]
#
# How it works, and why in this order:
#
#   1. `runtime/test/cab-lzx-corpus.mjs` builds a synthetic disc -- a Joliet ISO 9660 image holding an MSI
#      database and an LZX cabinet, in the layout of the retail disc -- and installs it with the
#      TypeScript installer. It only writes its output on success, so passing means that image is
#      installable and every file in it is reproduced byte for byte.
#   2. The manifest it writes records the MD5 of each installed file.
#   3. `InstallerCheck.kt` (in the app's install package) installs the same image with the Kotlin code and
#      compares every file and digest against that manifest.
#
# A failure here is a bug in a reader (ISO 9660, CFB, MSI, cabinet, LZX), in the install layout, or a
# drift between the two implementations -- all of them before the APK reaches a phone.
#
# Needs node and a JDK with kotlinc (`KOTLINC=/path/to/kotlinc` if it is not on PATH).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
KEEP=""
[ "${1:-}" = "--keep" ] && KEEP=1

OUT="${SHREK2_CORPUS_DIR:-$(mktemp -d)}"
[ -n "$KEEP" ] || trap 'rm -rf "$OUT"' EXIT

echo "== corpus: generating and installing with the reference implementation =="
node "$ROOT/runtime/test/cab-lzx-corpus.mjs" --out "$OUT"

KOTLINC="${KOTLINC:-kotlinc}"
if ! command -v "$KOTLINC" > /dev/null; then
  # The installer is exercising the APK's own code: skipping it would let a broken port ship.
  echo "kotlinc not found: set KOTLINC=/path/to/kotlinc (needed to compile the Kotlin installer)" >&2
  exit 1
fi

echo "== kotlin: compiling the installer =="
SRC="$ROOT/android/app/src/main/java/org/shrek2/launcher/install"
# The install package is Android-free but not self-contained: the error types it throws live next to the
# activity (they are what the screen shows the player), so they are compiled in as well.
ERRORS="$ROOT/android/app/src/main/java/org/shrek2/launcher/Errors.kt"
# shellcheck disable=SC2086
"$KOTLINC" -nowarn -d "$OUT/installer.jar" "$SRC"/*.kt "$ERRORS" 2>&1 |
  grep -vE '^(warning|WARNING):' || true
[ -f "$OUT/installer.jar" ] || { echo "the Kotlin installer does not compile" >&2; exit 1; }

echo "== kotlin: installing the same disc =="
# kotlinc puts the standard library on the classpath of what it runs, but `java` needs it explicitly.
STDLIB="$(dirname "$(readlink -f "$KOTLINC")")/../lib/kotlin-stdlib.jar"
[ -f "$STDLIB" ] || STDLIB=""
java -cp "$OUT/installer.jar${STDLIB:+:$STDLIB}" org.shrek2.launcher.install.InstallerCheck "$OUT"

echo "== packer: the installed game can be built into the APK =="
# The other delivery path: an installed copy is packaged into `assets/game/` and the launcher unpacks it.
# Both are checked here, with the corpus standing in for the game.
node "$ROOT/tools/pack-game.mjs" --from-dir "$OUT/install" --out "$OUT/assets"
[ -f "$OUT/assets/game/stamp.txt" ] || { echo "the packer wrote no stamp" >&2; exit 1; }
echo "ok: packaged $(grep -c . "$OUT/assets/game/index.txt") files, stamp $(cat "$OUT/assets/game/stamp.txt")"

echo "== packer: the archive fixtures for the 'already installed' path =="
# A player who already has the game does not have a disc: they hand the launcher a zip of the installed
# folder. The fixtures are built here (deflate, gzip and plain tar) so the launcher harness unpacks real
# bytes in CI, not whatever happens to be in someone's /tmp.
node "$ROOT/tools/game-archive.mjs" --out "$OUT/archives"

echo "== launcher: installing the corpus from a content:// document =="
# The same image, but through the screen a player uses: the launcher must read it out of the document it
# was given (not copy it first -- a silent short copy of a 548 MB disc is what broke a real install) and
# write the game files. This also fails if the launcher ever stops asking for the image itself.
# The launcher harness also unpacks the packaged game, which is the flow a player gets: install the APK,
# open it, play.
SHREK2_HARNESS_ISO="$OUT/shrek2.iso" SHREK2_HARNESS_ASSETS="$OUT/assets" \
  SHREK2_HARNESS_ARCHIVES="$OUT/archives" \
  KOTLINC="$KOTLINC" "$ROOT/tools/android-stubs-runtime.sh"

echo "ok: the disc installer works in both implementations"

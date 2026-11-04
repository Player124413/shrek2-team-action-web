#!/bin/bash
# End-to-end Android build:
#   1. the AOT image for the installed executable (aot/cli.ts) -> app assets
#   2. Gradle + NDK -> app/build/outputs/apk/release/app-release.apk
#   tools/build-android.sh [--exe <path to Shrek 2.exe>] [--meta metadata/<sha>.json] [--debug]
# Without --exe the existing assets are kept (a build with no image starts, but the game refuses to
# run until `aot/cli.ts image` has produced one).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXE=""; META=""; VARIANT=release
while [ $# -gt 0 ]; do
  case "$1" in
    --exe) EXE="$2"; shift 2 ;;
    --meta) META="$2"; shift 2 ;;
    --debug) VARIANT=debug; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
ASSETS="$ROOT/android/app/src/main/assets"
mkdir -p "$ASSETS"
if [ -n "$EXE" ]; then
  node "$ROOT/aot/cli.ts" image "$EXE" ${META:+--meta "$META"} --out "$ROOT/work/aot"
  node "$ROOT/aot/cli.ts" check "$ROOT/work/aot"
  cp "$ROOT/work/aot/game.sk2a" "$ROOT/work/aot/game.skx" "$ASSETS/"
fi
if [ ! -f "$ASSETS/game.sk2a" ]; then
  echo "warning: no AOT image in $ASSETS: the APK will build but the game will not start" >&2
fi
cd "$ROOT/android"
./gradlew "assemble${VARIANT^}"
echo "APK: android/app/build/outputs/apk/$VARIANT/app-$VARIANT.apk"

#!/bin/bash
# Builds the APK and checks the things that decide whether it can *replace* an installed copy.
#
#   tools/build-apk.sh [--debug] [--no-image] [--exe <Shrek 2.exe>] [--meta metadata/<sha>.json]
#
# What it guarantees, and why each step exists:
#   * versionCode strictly increases (tools/android-version.sh) -- otherwise Android refuses the update;
#   * the APK is signed with the project's release key (android/keystore.properties or SHREK2_* env) --
#     otherwise Android refuses it as "a different app";
#   * the AOT image is regenerated only when its input changed, because it is the expensive step and
#     the cached image stays valid across app updates (nothing about it depends on the APK);
#   * the finished APK is inspected: package, versionCode, signature, native ABI and asset presence.
#
# Environment: ANDROID_NDK_HOME (required for the native build), SHREK2_VERSION_CODE / _VERSION_NAME
# (optional, otherwise derived from git).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$ROOT/android/app/src/main/assets"
VARIANT=release
BUILD_IMAGE=1
EXE=""
META=""
while [ $# -gt 0 ]; do
  case "$1" in
    --debug) VARIANT=debug; shift ;;
    --no-image) BUILD_IMAGE=0; shift ;;
    --exe) EXE="$2"; shift 2 ;;
    --meta) META="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$ASSETS"

# ---- 1. AOT image ---------------------------------------------------------------------------------
if [ -n "$EXE" ]; then
  echo "== AOT image =="
  node "$ROOT/aot/cli.ts" image "$EXE" ${META:+--meta "$META"} --out "$ROOT/work/aot"
  node "$ROOT/aot/cli.ts" check "$ROOT/work/aot"
  cp "$ROOT/work/aot/game.sk2a" "$ROOT/work/aot/game.skx" "$ASSETS/"
elif [ "$BUILD_IMAGE" = 1 ] && [ ! -f "$ASSETS/game.sk2a" ]; then
  echo "warning: no AOT image in $ASSETS and no --exe given; the APK builds but the game will not start" >&2
fi
echo "image: $(du -h "$ASSETS/game.sk2a" 2>/dev/null | cut -f1 || echo none)"

# ---- 2. Version ------------------------------------------------------------------------------------
read -r CODE NAME <<<"$(bash "$ROOT/tools/android-version.sh" "${SHREK2_TAG:-}")"
export SHREK2_VERSION_CODE="$CODE"
export SHREK2_VERSION_NAME="$NAME"
echo "== version $SHREK2_VERSION_NAME ($SHREK2_VERSION_CODE) =="

# ---- 3. Signing --------------------------------------------------------------------------------------
if [ -f "$ROOT/android/keystore.properties" ] || [ -n "${SHREK2_KEYSTORE:-}" ]; then
  echo "signing: release key $(basename "${SHREK2_KEYSTORE:-$(grep -m1 '^storeFile' "$ROOT/android/keystore.properties" | cut -d= -f2-)}")"
else
  echo "signing: NONE -- the APK will be unsigned and cannot update an installed copy." >&2
  echo "         Create android/keystore.properties (see android/README.md, 'Updating in place')." >&2
fi

# ---- 4. Gradle ---------------------------------------------------------------------------------------
cd "$ROOT/android"
GRADLEW=./gradlew
if [ ! -x "$GRADLEW" ]; then
  # The wrapper is not committed here, so use whatever Gradle is on PATH (CI installs one).
  command -v gradle >/dev/null || {
    echo "no android/gradlew and no gradle on PATH" >&2
    echo "Run 'gradle wrapper' once in android/, or install Gradle and set PATH." >&2
    exit 1
  }
  GRADLEW=gradle
fi
"$GRADLEW" --no-daemon "assemble${VARIANT^}"

APK="$ROOT/android/app/build/outputs/apk/$VARIANT/app-$VARIANT.apk"
[ -f "$APK" ] || { echo "no APK at $APK" >&2; exit 1; }

# ---- 5. Inspect the result ---------------------------------------------------------------------------
echo "== APK =="
echo "$APK ($(du -h "$APK" | cut -f1))"

BUILD_TOOLS="$(ls -d "${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$BUILD_TOOLS" ] && [ -x "$BUILD_TOOLS/aapt2" ]; then
  "$BUILD_TOOLS/aapt2" dump badging "$APK" | grep -E "^package:|^native-code:|^application-label:" || true
fi
if [ -n "$BUILD_TOOLS" ] && [ -x "$BUILD_TOOLS/apksigner" ]; then
  "$BUILD_TOOLS/apksigner" verify --print-certs "$APK" | head -4
fi
unzip -l "$APK" | grep -E "lib/arm64-v8a/libshrek2\.so" || {
  echo "the APK is missing the native library" >&2
  exit 1
}
# The image is optional (a fork may have no reference executable), but say so loudly.
unzip -l "$APK" | grep -qE "assets/game\.sk2a" || {
  echo "warning: the APK carries no AOT image; the launcher will say the game is not compiled" >&2
}
if [ "$VARIANT" = release ]; then
  if [ -x "$BUILD_TOOLS/apksigner" ]; then
    "$BUILD_TOOLS/apksigner" verify "$APK" && echo "signature: ok (installs as an update)"
  else
    echo "warning: apksigner not found, the signature was not verified" >&2
  fi
fi
# Leave the tree clean: the image is a build input, not a source file.
rm -f "$ASSETS/game.sk2a" "$ASSETS/game.skx"
exit 0

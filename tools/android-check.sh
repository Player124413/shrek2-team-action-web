#!/bin/bash
# Host-side syntax check of the Android native sources (`android/app/src/main/cpp/*.cpp`).
#
# There is no NDK in every environment this repo is built in, so this compiles the platform layer, the
# AOT loader and the game entry point against tiny stub headers (tools/android-stub/) and the *shared*
# runtime headers. It catches the mistakes that otherwise only appear as a red Gradle job: wrong
# signatures, missing declarations in the anonymous namespace, typos in JNI names, real <cmath>/<mutex>
# usage. It does not link and it does not replace a real NDK build (the Gradle workflow does that).
#
#   tools/android-check.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CXX_BIN="${CXX:-g++}"
CPP="$ROOT/android/app/src/main/cpp"

# Same include order and defines as android/app/src/main/cpp/CMakeLists.txt (stub SDK headers first,
# then the runtime's own), and the same warning level the NDK build uses.
FLAGS=(
  -std=c++20 -fsyntax-only -Wall -Wextra -Werror -Wno-unused-parameter
  -DRT_PLAYER=1 -DGUEST_BASE=0
  -I "$ROOT/tools/android-stub"
  -I "$ROOT/runtime/include"
  -I "$ROOT/runtime/src"
  -I "$ROOT/runtime/src/platform"
  -I "$ROOT/third_party/khronos"
)

status=0
for f in platform_android.cpp aot_module.cpp game_main.cpp install_files.cpp; do
  printf '%-22s ' "$f"
  if out=$("$CXX_BIN" "${FLAGS[@]}" "$CPP/$f" 2>&1); then
    echo "ok"
  else
    echo "FAILED"
    echo "$out" | head -40
    status=1
  fi
done

# The JNI entry points the Kotlin side declares must exist with exactly these names: a rename on either
# side is a link-time surprise that only shows up as UnsatisfiedLinkError on a device.
echo
echo "JNI surface:"
for sym in nativeSetSurface nativeSurfaceSize nativeKey nativePad nativeFocus nativeMouseMove \
           nativeMouseButton nativeMouseTo nativeQuit nativeStart; do
  if grep -q "Java_org_shrek2_launcher_GameActivity_$sym\b" "$CPP"/*.cpp; then
    echo "  GameActivity.$sym ok"
  else
    echo "  GameActivity.$sym MISSING"
    status=1
  fi
done
for sym in installed copyFile finish; do
  if grep -q "Java_org_shrek2_launcher_InstallFiles_$sym\b" "$CPP"/*.cpp; then
    echo "  InstallFiles.$sym ok"
  else
    echo "  InstallFiles.$sym MISSING"
    status=1
  fi
done

exit $status

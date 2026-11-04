#!/bin/bash
# Verifies the DXT -> ETC2 transcoder (runtime/src/gles/blocks.h).
#   tools/etc2-test.sh
# Needs a host C++ compiler; no GL headers, no Android toolchain.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${TMPDIR:-/tmp}/shrek2-etc2-test"
"${CXX:-g++}" -O2 -std=c++20 -I "$ROOT/runtime/src" -o "$OUT" "$ROOT/tools/etc2-test.cpp"
"$OUT"

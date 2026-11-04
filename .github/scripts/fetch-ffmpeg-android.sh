#!/bin/bash
# Builds the minimal FFmpeg (Bink video + Bink audio) for arm64 Android and caches it.
#
# The Android runtime links libavcodec exactly like the desktop build does (hle/binkw32.cpp). Building
# it takes ~10 minutes, so CI keeps it in the Actions cache: the key is the FFmpeg version and the NDK
# revision, the two things that can change the result.
#
#   FFMPEG_VERSION=7.1.1 .github/scripts/fetch-ffmpeg-android.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${FFMPEG_VERSION:-7.1.1}"
OUT="$ROOT/work/tools/ffmpeg-android"

if [ -f "$OUT/lib/libavcodec.a" ]; then
  echo "FFmpeg for Android is already in $OUT"
  exit 0
fi

# sdkmanager does not export a path to what it installs: find the NDK under the SDK.
if [ -z "${ANDROID_NDK_HOME:-}" ] || [ ! -d "${ANDROID_NDK_HOME:-}" ]; then
  for candidate in "${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}"/ndk/*; do
    [ -d "$candidate" ] && export ANDROID_NDK_HOME="$candidate"
  done
fi
[ -n "${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_NDK_HOME" ] \
  || { echo "no NDK installed under the SDK; install it first" >&2; exit 1; }

SRC_DIR="$ROOT/work/tools/ffmpeg-src"
mkdir -p "$SRC_DIR"
if [ ! -d "$SRC_DIR/ffmpeg-$VERSION" ]; then
  echo "== fetching FFmpeg $VERSION =="
  curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" -o "$SRC_DIR/ffmpeg.tar.xz"
  tar -xJf "$SRC_DIR/ffmpeg.tar.xz" -C "$SRC_DIR"
fi

"$ROOT/tools/build-ffmpeg-android.sh" "$SRC_DIR/ffmpeg-$VERSION"

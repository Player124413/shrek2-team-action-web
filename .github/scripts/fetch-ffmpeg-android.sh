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
export FFMPEG_VERSION="$VERSION"
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

# Everything lives under work/tools, which is what the workflow caches.
SRC_DIR="$ROOT/work/tools/ffmpeg-src"
mkdir -p "$SRC_DIR"

# ffmpeg.org refuses connections often enough (one build in three failed on a connect timeout), and a
# release build must not depend on one host: try both, each a few times, before giving up.
if [ ! -d "$SRC_DIR/ffmpeg-$VERSION" ] && [ ! -d "$SRC_DIR/FFmpeg-n$VERSION" ]; then
  echo "== fetching FFmpeg $VERSION =="
  got=0
  for url in "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" \
             "https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n$VERSION.tar.gz"; do
    for attempt in 1 2 3; do
      echo "   $url (attempt $attempt)"
      if curl -fsSL --connect-timeout 20 --max-time 600 --retry 2 --retry-all-errors "$url" -o "$SRC_DIR/ffmpeg.tar"; then
        got=1
        break 2
      fi
      sleep $((attempt * 5))
    done
  done
  [ "$got" = 1 ] || { echo "could not download FFmpeg $VERSION from any mirror" >&2; exit 1; }
  tar -xf "$SRC_DIR/ffmpeg.tar" -C "$SRC_DIR"
  rm -f "$SRC_DIR/ffmpeg.tar"
fi
# The GitHub archive keeps the git tree, where configure may not be executable.
SRC_TREE="$SRC_DIR/ffmpeg-$VERSION"
[ -d "$SRC_TREE" ] || SRC_TREE="$SRC_DIR/FFmpeg-n$VERSION"
chmod +x "$SRC_TREE/configure" 2>/dev/null || true

echo "   source: $SRC_TREE"
"$ROOT/tools/build-ffmpeg-android.sh" "$SRC_TREE"

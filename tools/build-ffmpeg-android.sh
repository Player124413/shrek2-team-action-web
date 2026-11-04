#!/bin/bash
# Build the minimal FFmpeg (Bink video + Bink audio decoders) for the Android runtime, arm64 only.
# Output: work/tools/ffmpeg-android/{include,lib} -- what android/app/src/main/cpp/CMakeLists.txt links.
#   tools/build-ffmpeg-android.sh [path-to-ffmpeg-source]
# Needs an NDK toolchain: set ANDROID_NDK_HOME (or ANDROID_NDK_ROOT) to an NDK r26+ install.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/work/tools/ffmpeg-dl/ffmpeg-7.1.1}"
OUT="$ROOT/work/tools/ffmpeg-android"
BUILD="$ROOT/work/tools/ffmpeg-android-build"
NDK="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
if [ -z "$NDK" ] || [ ! -d "$NDK/toolchains/llvm/prebuilt" ]; then
  echo "ANDROID_NDK_HOME must point at an NDK install (r26 or newer)" >&2
  exit 1
fi
API=26  # minSdk of the app (AAudio's low-latency builder and GLES 3.0)
HOST_TAG=linux-x86_64
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG"
export PATH="$TOOLCHAIN/bin:$PATH"
mkdir -p "$BUILD"
cd "$BUILD"
"$SRC/configure" \
  --prefix="$OUT" --target-os=android --arch=aarch64 --enable-cross-compile \
  --cc="$TOOLCHAIN/bin/aarch64-linux-android$API-clang" \
  --cxx="$TOOLCHAIN/bin/aarch64-linux-android$API-clang++" \
  --ar="$TOOLCHAIN/bin/llvm-ar" --ranlib="$TOOLCHAIN/bin/llvm-ranlib" --nm="$TOOLCHAIN/bin/llvm-nm" \
  --sysroot="$TOOLCHAIN/sysroot" \
  --disable-programs --disable-doc --disable-debug --disable-autodetect \
  --disable-everything --disable-network --disable-avdevice --disable-avformat \
  --disable-swresample --disable-swscale --disable-avfilter --disable-vulkan \
  --enable-decoder=bink --enable-decoder=binkaudio_rdft --enable-decoder=binkaudio_dct \
  --enable-static --disable-shared \
  --extra-cflags="-O3 -fPIC" --extra-ldflags="-fPIC"
make -j"$(nproc)"
make install
echo "FFmpeg for Android arm64 installed in $OUT"

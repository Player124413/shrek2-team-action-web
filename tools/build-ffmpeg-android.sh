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
# A CI image installs the NDK through sdkmanager, which sets neither variable: fall back to the
# standard location (and to the revision pinned in build.gradle.kts when several are present).
if [ -z "$NDK" ] || [ ! -d "$NDK/toolchains/llvm/prebuilt" ]; then
  for candidate in "${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}"/ndk/*; do
    [ -d "$candidate/toolchains/llvm/prebuilt" ] && NDK="$candidate"
  done
fi
if [ -z "$NDK" ] || [ ! -d "$NDK/toolchains/llvm/prebuilt" ]; then
  echo "ANDROID_NDK_HOME must point at an NDK install (r26 or newer)" >&2
  echo "Looked in \${ANDROID_SDK_ROOT:-\${ANDROID_HOME:-~/Android/Sdk}}/ndk/*" >&2
  exit 1
fi
API=26  # minSdk of the app (AAudio's low-latency builder and GLES 3.0)
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) HOST_TAG=darwin-x86_64 ;;   # the NDK ships Rosetta binaries for Apple silicon
  Darwin-*) HOST_TAG=darwin-x86_64 ;;
  Linux-aarch64) HOST_TAG=linux-x86_64 ;;   # the NDK runs x86_64 tools under emulation
  *) HOST_TAG=linux-x86_64 ;;
esac
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG"
export PATH="$TOOLCHAIN/bin:$PATH"
mkdir -p "$BUILD"
cd "$BUILD"
# The archive is linked into libshrek2.so, so every object has to be position independent:
#   * --enable-pic builds the C code that way;
#   * --disable-neon drops libavutil/aarch64/tx_float_neon.S, which in 7.1.x addresses the transform
#     tables with absolute relocations (R_AARCH64_ADR_PREL_PG_HI21) and makes ld.lld refuse to link a
#     shared library. The decoders we use (bink, binkaudio) are plain C, so nothing is lost.
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
  --enable-pic --disable-neon \
  --extra-cflags="-O3 -fPIC -DPIC" --extra-ldflags="-fPIC"
make -j"$(nproc)"
make install

# Self-check: link the archives into a shared object, the way the app does. A non-PIC object only shows
# up here, after ten minutes of building, instead of in the Gradle job.
CHECK="$BUILD/link-check"
mkdir -p "$CHECK"
printf 'int shrek2_ffmpeg_probe(void) { return 0; }\n' > "$CHECK/probe.c"
if ! "$TOOLCHAIN/bin/aarch64-linux-android$API-clang" -shared -fPIC -o "$CHECK/libprobe.so" "$CHECK/probe.c" \
     -Wl,--whole-archive "$OUT/lib/libavcodec.a" "$OUT/lib/libavutil.a" -Wl,--no-whole-archive -lz -lm; then
  echo "FFmpeg was built, but its archives do not link into a shared library (non-PIC objects)." >&2
  exit 1
fi
echo "FFmpeg for Android arm64 installed in $OUT (links into a shared library)"

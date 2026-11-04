cmake_minimum_required(VERSION 3.22)
project(shrek2 C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# The runtime sources are shared with the desktop and web builds: same HLE layer, same D3D9 -> GLES
# translator, same audio mixer. Only the platform layer and the way guest code is loaded differ.
set(RUNTIME_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../runtime")
set(REPO_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../..")

set(RUNTIME_SOURCES
  ${RUNTIME_DIR}/src/cpu_helpers.c
  ${RUNTIME_DIR}/src/core/core.cpp
  ${RUNTIME_DIR}/src/core/memory.cpp
  ${RUNTIME_DIR}/src/core/objects.cpp
  ${RUNTIME_DIR}/src/hle/kernel32.cpp
  ${RUNTIME_DIR}/src/hle/kernel32_files.cpp
  ${RUNTIME_DIR}/src/hle/advapi32.cpp
  ${RUNTIME_DIR}/src/hle/user32.cpp
  ${RUNTIME_DIR}/src/hle/com.cpp
  ${RUNTIME_DIR}/src/hle/dsound.cpp
  ${RUNTIME_DIR}/src/hle/dinput8.cpp
  ${RUNTIME_DIR}/src/hle/binkw32.cpp
  ${RUNTIME_DIR}/src/audio/mixer.cpp
  ${RUNTIME_DIR}/src/d3d9/direct3d9.cpp
  ${RUNTIME_DIR}/src/d3d9/device.cpp
  ${RUNTIME_DIR}/src/d3d9/resources.cpp
  ${RUNTIME_DIR}/src/d3d9/formats.cpp
  ${RUNTIME_DIR}/src/d3d9/recorder.cpp
  ${RUNTIME_DIR}/src/gles/executor.cpp
  ${RUNTIME_DIR}/src/gles/renderer.cpp
  ${RUNTIME_DIR}/src/gles/ffp.cpp
  ${RUNTIME_DIR}/src/gles/sm_vs.cpp)

add_library(dlmalloc STATIC ${REPO_DIR}/third_party/dlmalloc/malloc.c)
target_compile_definitions(dlmalloc PRIVATE ONLY_MSPACES=1 MSPACES=1 USE_LOCKS=1 HAVE_MMAP=0 HAVE_MORECORE=0)
target_compile_options(dlmalloc PRIVATE -w -O2)

add_library(shrek2 SHARED
  ${RUNTIME_SOURCES}
  ${CMAKE_CURRENT_SOURCE_DIR}/platform_android.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/aot_module.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/game_main.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/install_files.cpp)

# RT_PLAYER: guest code is a separately loaded image (aot_module.cpp) rather than a linked table.
# GUEST_BASE: the guest window is identity-mapped at 0 so the generated code -- which keeps guest
# pointers in 32-bit registers -- needs no fixup. It costs a full 4 GiB reservation, which is why the
# mmap in memory.cpp is MAP_NORESERVE and why the 64-bit build must opt into it explicitly.
target_compile_definitions(shrek2 PRIVATE RT_PLAYER=1 GUEST_BASE=0)

# FFmpeg's arm64 assembly addresses libavutil's tables absolutely, which a shared library only allows
# for symbols that cannot be preempted. Hiding the static archives' symbols and binding internally is
# the fix, and it also keeps the dynamic symbol table down to our JNI entry points.
target_link_options(shrek2 PRIVATE -Wl,--exclude-libs,ALL -Wl,-Bsymbolic)
# GLES3/GLES2 headers come from the NDK's sysroot (the same API the device runs); only the KHR
# platform types are taken from the vendored copy, which is what the executor's extension prototypes
# expect.
target_include_directories(shrek2 PRIVATE
  ${RUNTIME_DIR}/include
  ${RUNTIME_DIR}/src
  ${RUNTIME_DIR}/src/platform
  ${REPO_DIR}/third_party/khronos)
target_compile_options(shrek2 PRIVATE -Wall -Wextra -Wno-unused-parameter)
target_link_libraries(shrek2 PRIVATE dlmalloc android log EGL GLESv3 aaudio)

# Bink video: the same FFmpeg decoders the desktop build links (libavcodec + libavutil built for
# arm64-android by tools/build-ffmpeg-android.sh). Without them binkw32.cpp has no decoder, so the
# script is a hard prerequisite for a build that can play the intro movies.
set(FFMPEG_ANDROID "${REPO_DIR}/work/tools/ffmpeg-android" CACHE PATH "arm64 Android build of libavcodec/libavutil")
if(EXISTS "${FFMPEG_ANDROID}/lib/libavcodec.a")
  target_include_directories(shrek2 PRIVATE ${FFMPEG_ANDROID}/include)
  target_link_libraries(shrek2 PRIVATE ${FFMPEG_ANDROID}/lib/libavcodec.a ${FFMPEG_ANDROID}/lib/libavutil.a z)
else()
  message(FATAL_ERROR "No Android FFmpeg in ${FFMPEG_ANDROID}: run tools/build-ffmpeg-android.sh first")
endif()

# `android/` — the native port (arm64)

The desktop site translates the game's x86 code in the player's browser. This port keeps the same
front end and verification, but compiles the translated code to **AArch64 machine code on the
device** (`aot/`) and runs it on a real CPU instead of interpreting it. Everything else is the same
C++ runtime the desktop and web builds use: the HLE layer, the D3D9 → GLES translator, the mixer.

```
Shrek 2.exe --recomp/--> IR --aot/--> ARM64 image --mmap(RX)--> native CPU
                                    (built once, cached)
```

## What the player gets

* `LauncherActivity` — checks the install, offers to copy the game files in, starts the game.
* `GameActivity` — a `SurfaceView` handed to EGL, the touch overlay on top, input forwarded over JNI.
* `TouchOverlayView` — virtual pad (d-pad + A/B + shoulder + Escape), bound to *Windows virtual-key
  codes*, so the game's own control-remapping screen works and a Bluetooth keyboard, a controller and
  the touch pad all arrive through the same path. A tap in empty space is a left click, a drag is
  pointer motion: the game's menus are mouse-driven.
* Bindings persist per player in `files/touch-bindings.json`.

Nothing is uploaded anywhere: the game files the player supplies stay in the app's private storage,
and the only binary shipped in the APK is the AOT image built from *their* executable.

## Building

There is **no Android toolchain in the sandbox this port was written in** — no JDK, SDK, NDK, Gradle or
CMake — so neither the Kotlin nor the C++ has been compiled or run here. What *is* verified:

* the AOT compiler and its image format: `node aot/test/{enc,arch,module}.test.mjs` (encoder and
  generated code against a reference interpreter in Unicorn, and a full module load/relocate/run);
* the image builder on a real executable-shaped PE: `node aot/cli.ts image …` then `check …`.

To build:

```sh
# 1. NDK r26+ (set ANDROID_NDK_HOME), JDK 17, Android SDK with platform 35
export ANDROID_NDK_HOME=$HOME/android-ndk-r27

# 2. Bink decoders for arm64 (the runtime links them like the desktop build does)
tools/build-ffmpeg-android.sh

# 3. the AOT image for your own executable + the APK
tools/build-android.sh --exe "/path/to/Shrek 2.exe" --meta metadata/<sha256>.json
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

`--meta` is optional; without it the front end discovers functions itself (slower, slightly less
complete — see `recomp/src/translate.ts`).

## Layout

| Path | What it is |
| --- | --- |
| `app/src/main/cpp/CMakeLists.txt` | links `runtime/src/**` (shared with desktop/web) + the Android platform layer + the AOT loader |
| `platform_android.cpp` | `plat::` on Android: EGL/GLES 3 on the `ANativeWindow`, AAudio, VK → set-1 scancode mapping, pads |
| `aot_module.cpp` | the image loader: `mmap`, relocations, `rt::game_owns`/`game_call` behind `RT_PLAYER`, trap messages |
| `game_main.cpp` | the game thread: `memory_init`/`vfs_init`/`registry_init`/`load_image`/`aot_load`/`dispatch_init` |
| `install_files.cpp` | copies the player's files into `files/install/`, the layout `vfs_init` expects |
| `java/.../GameActivity.kt` | surface, lifecycle, keyboard/controller → JNI, back gesture → Escape |
| `java/.../TouchOverlayView.kt` | the virtual pad and its bindings |
| `java/.../LauncherActivity.kt` | install wizard and "Play" |
| `java/.../InstallFiles.kt` | install state and the `copyFile`/`finish` JNI calls |

## How a launch works

1. `LauncherActivity` finds `files/install/Game/Shrek 2.exe`. If it is missing, it copies a folder the
   player picks with the system file picker.
2. `GameActivity` creates the surface, unpacks `game.sk2a`/`game.skx` from the APK into `files/cache/`
   and calls `nativeStart(filesDir)`.
3. `game_main.cpp` waits for the surface, maps the guest address space (`GUEST_BASE=0`, so the
   generated code's 32-bit guest pointers work unchanged), loads the image and starts the guest at the
   PE entry point exactly like `runtime/src/main.cpp`.
4. Every guest call goes through `rt::game_owns`/`rt::game_call` → a pointer into the mapped image.

## Deliberate limitations

* **arm64 only.** The code generator emits AArch64; there is no fallback interpreter in the APK. An
  arm32 or x86 phone cannot run this build.
* **No on-device recompiler.** The AOT image is produced on a build machine (`aot/cli.ts`, which needs
  Node and the recompiler front end) and packaged. Running the front end on the phone would mean
  shipping QuickJS-ng plus the whole recompiler; that is a later step, not part of this scaffold.
* **No on-device ISO parsing.** The CDFS/CAB/CFB decoders are the TypeScript ones in
  `installer/src/`; the app copies an already-installed tree. `installer/src/cli.ts` can unpack a disc
  on a build machine, and the folder copy path above takes it from there.
* **Guest memory is a 4 GiB reservation.** `memory_init()` maps the window at `GUEST_BASE` with
  `MAP_NORESERVE`, which is fine for a 64-bit process but means the app cannot run in a 32-bit one.
* **First frame latency.** The guest starts on its own thread; the activity shows the surface as soon
  as EGL is up, so there is a short black window while the game boots.

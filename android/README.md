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
# 0. once: create the signing key (see "Updating in place" below)
tools/android-keygen.sh

# 1. NDK r26+ (set ANDROID_NDK_HOME), JDK 17, Android SDK with platform 35
export ANDROID_NDK_HOME=$HOME/android-ndk-r27

# 2. Bink decoders for arm64 (the runtime links them like the desktop build does)
tools/build-ffmpeg-android.sh

# 3. the AOT image for your own executable + the APK, with the update checks
tools/build-apk.sh --exe "/path/to/Shrek 2.exe" --meta metadata/<sha256>.json
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

CI does the same on every push (`.github/workflows/android.yml`): the tests, the native syntax check and
the release rules first, then the image, then the APK, and on a `v*` tag a release whose APK is proven
to install as an update over the previous one. The pieces that can run without an SDK are testable
locally:

```sh
tools/android-check.sh     # native platform layer compiles (-Werror) without an NDK
tools/release-test.sh      # version codes + "will this APK replace the installed one?"
node tools/check-workflows.mjs   # the workflow itself: jobs, needs, step outputs, bash -n
```

## Updating in place

An APK only *replaces* an installed app when three things hold; Android refuses everything else:

| Requirement | Where it is enforced |
| --- | --- |
| same `applicationId` (`org.shrek2.launcher`) | `app/build.gradle.kts` |
| strictly higher `versionCode` | `tools/android-version.sh` (tags: `v1.2.3` -> `10203`; dev: commit count) |
| same signing certificate | `android/keystore.properties` / the `SHREK2_*` CI secrets |

The key is created once (`tools/android-keygen.sh`, 4096-bit RSA, valid 10,000 days) and must be backed
up: rotate it and every player has to uninstall, which also deletes their install and saves. CI compares
the new APK's certificate with the last release's before publishing and fails the release if they differ.

What an update does *not* lose:

* the install and the AOT image: both live in `noBackupFilesDir` (`install/`, `cache/`), which Android
  never touches on an update (and does not back up -- it is the player's own game data);
* `registry.txt` (settings and key bindings) and `touch-bindings.json`;
* the AOT image is re-unpacked only when the packaged one changed: `cache/image.version` holds the
  versionName that produced it.

A *debug* build is deliberately a different app (`applicationIdSuffix = ".debug"`), so testing a debug
APK never uninstalls the release one.

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
| `runtime/src/gles/blocks.h` | shared with the desktop and web builds: DXT decode + ETC2/EAC transcode (`tools/etc2-test.sh` verifies it) |
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

## Performance

Where the time goes, and what the port does about it:

* **Guest code runs as native AArch64.** No interpreter, no per-instruction dispatch: a guest function
  is one `blr` away (`rt::game_call`), and calls between functions in the image are direct.
* **The image is optimised before it is compiled** (`aot/src/opt.ts`): constant folding, dead x86 flag
  stores (with the carry/parity computation behind them), and redundant register syncs. On the
  differential corpus that is ~44% fewer code bytes for identical behaviour, measured against running
  the same test with the optimiser switched off.
* **Flags are computed lazily.** The emitter only evaluates `cf/pf/af/zf/sf/of` when the IR reads them,
  and the optimiser removes most of the reads, so a `sub` is a `subs` rather than a record plus six
  expressions.
* **Register file.** Guest GPRs, `ftop` and `df` live in callee-saved host registers; the `Cpu` struct
  is touched only at calls, helper boundaries and returns (`syncout`/`syncin` in `arch-arm64.ts`).
* **Rendering** is a single GLES 3 pipeline with a state cache (`runtime/src/gles/renderer.cpp`): the
  D3D9 fixed-function state is translated once per change, not per draw, and stream buffers are
  re-used.
* **Boot cost** is paid once: the AOT image is built at packaging time, cached in `files/cache/` on
  first launch, and memory-mapped `PROT_EXEC` afterwards (`aot_module.cpp`), so a cold start maps
  ~10s of MB instead of compiling anything.

Not done yet, in rough order of expected payoff: register allocation across the pinned set for
non-guest locals (many spills are still stack slots), common-subexpression elimination for repeated
`0x401000 + x` address formation, and a per-function LRU code cache so that hot functions stay mapped
when an image outgrows what a device will keep resident.

### Textures: ETC2

Shrek 2's art is DXT (S3TC). S3TC is a desktop GL extension: most mobile GPUs do not expose it and
WebGL implementations usually gate it, so a port that assumed it would either show untextured surfaces
or expand every texture to RGBA8 and keep 4x the memory resident. ETC2/EAC is *core* in GLES 3.0 and in
WebGL 2, so `runtime/src/gles/blocks.h` decodes each DXT block with the reference decoder and
re-encodes it as ETC2 at upload time (RGB8 for DXT1, RGBA8 EAC for the alpha formats) — one pass per
texture level, same GPU memory as DXT, no per-frame cost.

That is lossy, which is why it is only used where the *game* never reads the pixels back: rasterized
triangles sample textures through the guest's own 32-bit addresses, so the GL copy exists only for the
GPU. Surfaces the game locks or copies take the RGBA8 path, which stays bit-exact.

Verified by `tools/etc2-test.sh`: it decodes DXT, transcodes, and decodes the ETC2 back with an
independent decoder written from the Khronos spec (40 dB PSNR on gradients, 25 dB on hard-edged
checkerboards, 28 dB on alpha), and includes a bit-layout probe that fails if any field moves.

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

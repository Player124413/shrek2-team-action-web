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

# 3. the AOT image for your own executable + the debug APK, with the update checks
tools/build-apk.sh --debug --exe "/path/to/Shrek 2.exe" --meta metadata/<sha256>.json
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Only the debug variant is built: it is signed with the committed debug key, so it installs, and it
replaces the installed app on every update (same package, higher versionCode, same certificate) without
touching the game files.

CI does the same on every push (`.github/workflows/android.yml`): the tests, the native syntax check and
the release rules first, then the image, then the APK, and on a `v*` tag a release whose APK is proven
to install as an update over the previous one. The pieces that can run without an SDK are testable
locally:

```sh
tools/ci-local.sh          # the workflow's `checks` job, step by step, on this machine
tools/ci-local.sh apk      # the build job (falls back to validation when there is no Gradle)
tools/android-check.sh     # native platform layer compiles (-Werror) without an NDK
tools/release-test.sh      # version codes, key generation, "will this APK replace the installed one?"
tools/installer-test.sh    # the disc installer: a synthetic disc, installed by both implementations
tools/android-stubs.sh     # the launcher type-checks against generated Android API stubs
tools/android-stubs-runtime.sh  # ...and runs its start-up on a JVM (catches crashes a type check cannot)
node tools/check-workflows.mjs   # the workflow itself: jobs, needs, step outputs, bash -n
```

## CI

`.github/workflows/android.yml` runs on every branch, on pull requests, and on `v*` tags:

| job | what it proves |
| --- | --- |
| `checks` | the AOT suites, the ETC2 transcoder, the native syntax gate, the release rules, shellcheck, the workflow schema |
| `image` | the AOT image builds and re-reads correctly (skipped when no reference executable is configured) |
| `apk` | Gradle + NDK + CMake produce `shrek2-<version>.apk`, and its package, versionCode, signature and ABI are inspected |
| `release` | on a tag: the APK is proven to install as an update over the previous release, then published |

Secrets (optional -- without them the APK is built unsigned and never published):

| secret | purpose |
| --- | --- |
| `SHREK2_KEYSTORE_BASE64` | base64 of the release `.jks` (`tools/android-keygen.sh` prints the command) |
| `SHREK2_KEYSTORE_PASSWORD`, `SHREK2_KEY_ALIAS`, `SHREK2_KEY_PASSWORD` | its credentials |
| `SHREK2_EXE_BASE64` | base64 of the player's own `Shrek 2.exe`, to bake the AOT image into the APK |

Everything the workflow does can be run locally: `tools/ci-local.sh` for the step order,
`node tools/check-workflows.mjs` for the file itself.

### Why an APK said "app not installed ... package appears to be corrupt"

An **unsigned** APK cannot be installed at all, and before this the workflow produced one whenever the
release-key secrets were absent (`app-release-unsigned.apk`). Now:

* every build is signed: the release key when it is configured, otherwise `android/debug.keystore`;
* the release and debug variants share the package and the key, so they replace each other in place;
* the workflow fails if `apksigner` does not verify the APK, or if it finds no signer certificate --
  the build cannot quietly publish something a phone will refuse.

Installing over an older build that was signed with a *different* key (any build made before the
committed debug key existed) still requires one uninstall; from then on updates apply in place.

### Notes from the first real runs

Two things only a real NDK and a real linker caught:

* `runtime/src/core/core.cpp` read the interrupted PC out of `ucontext_t` for the sampling profiler,
  which only exists in that layout on x86-64. It is now compiled out everywhere else -- the
  watchdog (which is what Android needs) still runs.
* FFmpeg's arm64 archive contains absolute references to its own tables, which a shared library
  only accepts for non-preemptible symbols: the app links with `-Wl,--exclude-libs,ALL -Wl,-Bsymbolic`,
  and `tools/build-ffmpeg-android.sh` links a probe `.so` after installing so a non-PIC build fails
  there instead of ten minutes later in Gradle.

## Installing from a disc image

"Install from your own disc" takes the **ISO image** of the retail disc -- not an installed folder, not
an `.exe`. The launcher streams the image into `noBackupFilesDir/cache/disc.iso` (a `content://`
document has no positional reads, and the installer needs random access), then reads it directly:

| Step | Code |
| --- | --- |
| volume descriptor, Joliet directory tree | `install/Iso9660.kt` |
| `SHREK2.MSI` as an OLE compound file | `install/Cfb.kt` |
| string pool, schema, `File`/`Component`/`Directory`/`Media` | `install/Msi.kt` (layout in `Msi.kt`'s `readLayout`) |
| cabinets named by the MSI `Media` table | `install/Cabinet.kt` |
| LZX frames, 64 KiB window, 32 KiB CFB blocks | `install/Lzx.kt` |
| MD5 of every installed file against `MsiFileHash` | `install/Md5.kt` |
| the install itself, with progress | `install/Installer.kt` |

The Kotlin code is a port of `installer/src/` (the TypeScript installer the web build uses), and the two
are held together by `tools/installer-test.sh`: it generates a synthetic disc in the retail layout,
installs it with the TypeScript implementation, requires the Kotlin one to reproduce every file and every
digest, then installs it *through the launcher* from a `content://` document and checks that a provider
which stops early is reported as an incomplete file. Cut-off images (a whole sector missing, a 48-byte
short tail, a cut inside a directory) must each be rejected by name. That check runs on every push, in
the `checks` job.

Graphics settings (resolution, shadows, anti-aliasing, distance clipping, view distance) are on the same
screen: they are written into `registry.txt`, the file the runtime's registry HLE reads, so the game
picks them up at its next start. `Registry.kt`/`Settings.kt` mirror `web/src/registry.ts` and
`web/src/settings.ts`, including the first-run defaults and the version-1 migration.

## Updating in place

An APK only *replaces* an installed app when three things hold; Android refuses everything else:

| Requirement | Where it is enforced |
| --- | --- |
| same `applicationId` (`org.shrek2.launcher`) | `app/build.gradle.kts` |
| strictly higher `versionCode` | `tools/android-version.sh` (tags: `v1.2.3` -> `10203`; dev: commit count) |
| same signing certificate | `android/debug.keystore` (committed), or `android/keystore.properties` / the `SHREK2_*` secrets |

### The default: the committed debug key

`android/debug.keystore` is **in the repository on purpose**: alias `androiddebugkey`, password
`android`, `CN=Android Debug`. It is public by definition -- every Android build tool has one -- and it
is the only way a build straight out of CI can be installed, let alone updated:

* an **unsigned** APK cannot be installed at all: the phone says *"app not installed as package appears
  to be corrupt"*;
* a **newly generated** debug key on every runner changes the certificate, and Android then treats the
  build as a different app: *"app not installed"*, or an update that demands uninstalling first;
* with one committed key, every build of this app -- CI, a local `assembleDebug`, a local
  `assembleRelease` -- carries the same certificate and replaces the installed copy in place.

Debug and release variants share the package and the key, so they replace each other too. A debug build
is only more debuggable; it will not sit next to the game as a second app.

### The release key (optional, for publishing)

When a release key is configured, a release build uses it instead (CI builds the debug variant only,
the one a player installs; `tools/build-apk.sh` without `--debug` still produces a release APK locally):

```sh
tools/android-keygen.sh          # once: creates android/release.jks + android/keystore.properties
```

CI reads the same key from `SHREK2_KEYSTORE_BASE64` and friends; without them it signs with the debug key
and says so in the job summary. Switching from the debug key to a release key is a *change of
certificate*: players who installed a debug-signed build have to uninstall once (losing their install)
unless that switch is made before the first public release. Keep the release key backed up; CI compares
each release's certificate with the previous release's and fails the release if it changed.

What an update does *not* lose:

* the install and the AOT image: both live in `noBackupFilesDir` (`install/`, `cache/`), which Android
  never touches on an update (and does not back up -- it is the player's own game data);
* `registry.txt` (settings and key bindings) and `touch-bindings.json`;
* the AOT image is re-unpacked only when the packaged one changed: `cache/image.version` holds the
  versionName that produced it.

A *debug* build is the same app: it updates the installed copy (same package, same key) instead of
sharing the phone with a second, differently signed one.

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
| `java/.../LauncherActivity.kt` | disc-image install wizard, graphics settings, "Play" |
| `java/.../install/` | the installer: ISO 9660, CFB, MSI, cabinets, LZX, MD5 (a port of `installer/src/`) |
| `java/.../InstallFiles.kt` | install state and the `copyFile`/`finish` JNI calls |

## How a launch works

1. `LauncherActivity` finds `files/install/Game/Shrek 2.exe`. If it is missing, "Install from your own
   disc" asks for the ISO image of the player's disc and installs the game out of it with `install/`.
   The image is *not* copied first: `ContentSource` reads it through the document provider in 64 KiB
   windows (`openInputStream` + `skip`), so a 548 MB disc needs no space in the cache and cannot be
   silently truncated on the way in -- an earlier version copied it, and a copy that stopped early made a
   548 MB disc look like a 20 MB one. Nothing is uploaded; the image never leaves the device.
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
* **The disc must be an ISO image.** The installer reads ISO 9660/Joliet only; a raw `.bin`/`.cue` pair
  or a mounted folder has to be turned into an ISO first. `installer/src/cli.ts` does the same job on a
  build machine with the TypeScript implementation, which is what `tools/installer-test.sh` holds the
  Kotlin one against.
* **No on-device recompiler.** The AOT image is produced on a build machine (`aot/cli.ts`, which needs
  Node and the recompiler front end) and packaged. Running the front end on the phone would mean
  shipping QuickJS-ng plus the whole recompiler; that is a later step, not part of this scaffold.
* **Guest memory is a 4 GiB reservation.** `memory_init()` maps the window at `GUEST_BASE` with
  `MAP_NORESERVE`, which is fine for a 64-bit process but means the app cannot run in a 32-bit one.
* **First frame latency.** The guest starts on its own thread; the activity shows the surface as soon
  as EGL is up, so there is a short black window while the game boots.

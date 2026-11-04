// Android entry point: the game runs on a dedicated thread started by the Java activity once a
// surface exists, exactly like `src/main.cpp` on the desktop.
//
// The executable and its data come from the install directory in the app's private storage; guest
// code comes from the AOT image built on the device (see `aot/src/`) and loaded here. `RT_PLAYER`
// makes `core.cpp` route every dispatch through `rt::game_owns`/`rt::game_call`, which this build
// implements in `aot_module.cpp` instead of linking a recompiled table.
#include <dlfcn.h>
#include <jni.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <thread>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "core/objects.h"
#include "core/rt.h"
#include "hle/registry.h"
#include "platform/platform.h"

namespace {

std::string g_root;              // app-private storage root ("/data/user/0/<pkg>/files")
std::string g_install;           // g_root + "/install"
std::atomic<bool> g_started{false};

}  // namespace

namespace rt {
// Provided by aot_module.cpp.
bool aot_load(const std::string& image_path, const std::string& side_path);
const char* aot_trap_message(uint32_t id);
}  // namespace rt

// The generated code reports a trap by id; the message is in the side table the loader read.
extern "C" void rt_trap_id(Cpu* c, uint32_t id) {
  (void)c;
  const char* msg = rt::aot_trap_message(id);
  rt::fatal("guest trap: %s", msg ? msg : "unknown trap id");
}

namespace {

[[noreturn]] void run_game() {
  rt::memory_init();
  rt::vfs_init(g_install);
  rt::registry_init(g_root + "/registry.txt");
  if (!plat::init()) rt::fatal("platform init failed");

  // The activity starts us as soon as the install exists; the SurfaceView may still be attaching.
  // The renderer creates its EGL context on the first D3D9 call, so wait for the surface instead of
  // failing a launch that races window setup.
  for (int i = 0; i < 300 && !plat::has_window(); i++) std::this_thread::sleep_for(std::chrono::milliseconds(16));
  if (!plat::has_window()) rt::fatal("no surface after 5 s");

  std::ifstream f(g_install + "/Game/Shrek 2.exe", std::ios::binary);
  if (!f) rt::fatal("cannot open %s/Game/Shrek 2.exe", g_install.c_str());
  std::vector<uint8_t> exe((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  rt::load_image(exe);

  // The image is compiled on first launch (or after a game update) and cached next to the install.
  const std::string image = g_root + "/cache/game.sk2a";
  const std::string side = g_root + "/cache/game.skx";
  // GameActivity unpacks the image shipped in the APK into the cache directory before it starts us.
  if (access(image.c_str(), R_OK) != 0) rt::fatal("no AOT image at %s: build the APK with tools/build-android.sh", image.c_str());
  if (!rt::aot_load(image, side)) rt::fatal("cannot load the AOT image at %s", image.c_str());
  rt::dispatch_init();
  rt::watchdog_start();

  rt::GuestThread* t = rt::create_guest_thread(0x100000);
  rt::bind_host_thread(t);
  rt::log(rt::Log::Info, "starting guest at entry %08x", rt::image_entry());
  uint32_t code = rt::guest_call(&t->cpu, rt::image_entry(), {});
  rt::process_exit(code);
}

}  // namespace

extern "C" JNIEXPORT void JNICALL Java_org_shrek2_launcher_GameActivity_nativeStart(JNIEnv* env, jclass, jstring root) {
  if (g_started.exchange(true)) return;
  const char* utf = env->GetStringUTFChars(root, nullptr);
  g_root = utf;
  g_install = g_root + "/install";
  env->ReleaseStringUTFChars(root, utf);

  // The game owns the thread it starts on and never returns (`process_exit`); detaching is enough.
  std::thread([] {
    pthread_setname_np(pthread_self(), "shrek2-game");
    run_game();
  }).detach();
}

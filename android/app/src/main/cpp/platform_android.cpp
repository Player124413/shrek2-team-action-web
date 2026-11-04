// Android platform layer: EGL/GLES 3 surface on the game's SurfaceView, touch and pad input mapped
// to the DirectInput codes the game reads, and AAudio output.
//
// This is the Android twin of platform_sdl.cpp. The interesting part is input: the game is a 2004
// Windows title that only understands keyboard scancodes and DirectInput pads, so the touch overlay
// (drawn by the Java layer) sends *virtual key* events here, which are converted into the same
// Windows VK + PC set-1 scancode pairs a physical keyboard would produce. That keeps the game's own
// control remapping screen working, and means a bluetooth keyboard behaves exactly like the overlay.
#include <android/input.h>
#include <android/log.h>
#include <android/native_window.h>
#include <android/native_window_jni.h>
#include <aaudio/AAudio.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <jni.h>
#include <time.h>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "../core/rt.h"
#include "platform.h"

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "shrek2", __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, "shrek2", __VA_ARGS__)

namespace plat {
namespace {

// ---- Window / EGL ------------------------------------------------------------------------------

// EGL configs: the preferred one (4x MSAA) and the fallback every GLES 3 device must accept.
const EGLint kMsaaConfigAttrs[] = {
    EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
    EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
    EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
    EGL_DEPTH_SIZE, 24, EGL_STENCIL_SIZE, 8,
    EGL_SAMPLE_BUFFERS, 1, EGL_SAMPLES, 4,
    EGL_NONE,
};
const EGLint kConfigAttrs[] = {
    EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
    EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
    EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
    EGL_DEPTH_SIZE, 24, EGL_STENCIL_SIZE, 8,
    EGL_NONE,
};

ANativeWindow* g_window = nullptr;
EGLDisplay g_display = EGL_NO_DISPLAY;
EGLSurface g_surface = EGL_NO_SURFACE;
EGLContext g_context = EGL_NO_CONTEXT;
EGLConfig g_config = nullptr;
int g_width = 0, g_height = 0;
std::mutex g_window_mutex;

/**
 * One Windows key: the virtual-key code the game compares against, and the PC set-1 scancode
 * DirectInput reports. `dik` with bit 8 set means an E0-prefixed (extended) key.
 */
struct KeyMap {
  uint32_t vk;
  uint32_t dik;
};

// The keys the game can be bound to and that the touch overlay can emit. Virtual-key codes are the
// Win32 ones; scancodes are the set-1 values DirectInput uses.
const KeyMap kKeys[] = {
    {0x1b, 0x01},  // escape
    {0x0d, 0x1c},  // return
    {0x20, 0x39},  // space
    {0x09, 0x0f},  // tab
    {0x08, 0x0e},  // backspace
    {0x10, 0x2a},  // shift
    {0x11, 0x1d},  // control
    {0x12, 0x38},  // alt
    {0x25, 0x14b}, // left
    {0x26, 0x148}, // up
    {0x27, 0x14d}, // right
    {0x28, 0x150}, // down
    {0x24, 0x147}, // home
    {0x23, 0x14f}, // end
    {0x21, 0x149}, // page up
    {0x22, 0x151}, // page down
    {0x2d, 0x152}, // insert
    {0x2e, 0x153}, // delete
    {0x70, 0x3b},  // F1
    {0x71, 0x3c},
    {0x72, 0x3d},
    {0x73, 0x3e},
    {0x74, 0x3f},
    {0x75, 0x40},
    {0x76, 0x41},
    {0x77, 0x42},
    {0x78, 0x43},
    {0x79, 0x44},
    {0x7a, 0x57},
    {0x7b, 0x58},
};

// Virtual-key codes the overlay uses for gamepad buttons (see NativeInput.kt).
constexpr uint32_t kPadVkA = 0x1000, kPadVkB = 0x1001, kPadVkX = 0x1002, kPadVkY = 0x1003;
constexpr uint32_t kPadVkLb = 0x1004, kPadVkRb = 0x1005, kPadVkLt = 0x1006, kPadVkRt = 0x1007;
constexpr uint32_t kPadVkStart = 0x1008, kPadVkBack = 0x1009;

uint8_t g_keys[256];  // 256 DirectInput scan codes, 0x80 set while held
GamepadState g_pads[kMaxGamepads];
float g_rumble[kMaxGamepads][2];
std::mutex g_queue_mutex;
std::vector<InputEvent> g_queue;

MouseState g_mouse{};
std::mutex g_mouse_mutex;
bool g_focused = true;
bool g_cursor_visible = true;

void push(const InputEvent& e) {
  std::lock_guard<std::mutex> lock(g_queue_mutex);
  if (g_queue.size() < 4096) g_queue.push_back(e);
}

uint64_t now_ms() {
  timespec ts{};
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000u + (uint64_t)(ts.tv_nsec / 1000000);
}

/**
 * Virtual-key codes above the Win32 range are not keys but *gamepad buttons* the touch overlay emits:
 * a virtual pad has to reach the game exactly where a real pad does, since the game reads its movement
 * from DirectInput. Returns the `plat::PadButton` bit, or 0 when `vk` is an ordinary key.
 */
uint32_t virtualPadButton(uint32_t vk) {
  switch (vk) {
    case kPadVkA: return PadA;
    case kPadVkB: return PadB;
    case kPadVkX: return PadX;
    case kPadVkY: return PadY;
    case kPadVkLb: return PadLB;
    case kPadVkRb: return PadRB;
    case kPadVkLt: return PadLT;
    case kPadVkRt: return PadRT;
    case kPadVkStart: return PadStart;
    case kPadVkBack: return PadBack;
    default: return 0;
  }
}

/** Set-1 scancode for a Windows virtual-key code (what DirectInput reports for that key). */
uint32_t scancodeFor(uint32_t vk) {
  for (const KeyMap& k : kKeys) {
    if (k.vk == vk) return k.dik;
  }
  // Letters and digits: set-1 scancodes follow the physical keyboard layout, not the alphabet.
  static const uint8_t kLetterDik[26] = {0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24,
                                         0x25, 0x26, 0x32, 0x31, 0x18, 0x19, 0x10, 0x13, 0x1f, 0x14,
                                         0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c};
  if (vk >= 'A' && vk <= 'Z') return kLetterDik[vk - 'A'];
  if (vk >= '0' && vk <= '9') return 0x02 + (vk - '0');
  return 0;
}

// DirectInput keyboard indices: extended keys use 0x80 | scancode (e.g. DIK_UP = 0xC8), which is
// the layout the HLE keyboard code assumes (see platform_sdl.cpp).
uint8_t dik_index(uint32_t dik) { return (uint8_t)((dik & 0x100) ? 0x80 | (dik & 0x7f) : dik); }

void set_key(uint32_t dik, bool down) { g_keys[dik_index(dik)] = down ? 0x80 : 0; }

// ---- Audio -------------------------------------------------------------------------------------

struct Audio {
  AAudioStream* stream = nullptr;
  void (*render)(float*, int) = nullptr;
  int rate = 0;
  int channels = 2;
} g_audio;

aaudio_data_callback_result_t audio_callback(AAudioStream* stream, void* user, void* data, int32_t frames) {
  (void)stream;
  (void)user;
  if (!g_audio.render) {
    memset(data, 0, (size_t)frames * g_audio.channels * sizeof(float));
    return AAUDIO_CALLBACK_RESULT_CONTINUE;
  }
  g_audio.render((float*)data, frames);
  return AAUDIO_CALLBACK_RESULT_CONTINUE;
}

}  // namespace

// ---- Lifecycle (called from the Java side) -----------------------------------------------------

bool init() {
  memset(g_keys, 0, sizeof g_keys);
  LOGI("platform init");
  return true;
}

// The window is the SurfaceView owned by the Java activity: `nativeSetSurface` hands us the
// ANativeWindow, so there is nothing to create here.
void create_window(const std::string& title, int width, int height) {
  (void)title;
  (void)width;
  (void)height;
}

bool has_window() { return g_window != nullptr; }

void get_display_size(int* width, int* height) {
  if (g_width > 0) {
    *width = g_width;
    *height = g_height;
  } else {
    *width = 1920;
    *height = 1080;
  }
}

void get_window_size(int* width, int* height) {
  if (g_width > 0) {
    *width = g_width;
    *height = g_height;
  } else {
    *width = 640;
    *height = 480;
  }
}

void set_window_size(int width, int height) {
  // The surface size is owned by the OS; nothing to do beyond remembering it for the renderer.
  if (width > 0 && height > 0) {
    g_width = width;
    g_height = height;
  }
}

void show_cursor(bool visible) { g_cursor_visible = visible; }

// ---- Input -------------------------------------------------------------------------------------

void poll_events(std::vector<InputEvent>& out) {
  {
    std::lock_guard<std::mutex> lock(g_queue_mutex);
    out.insert(out.end(), g_queue.begin(), g_queue.end());
    g_queue.clear();
  }
  std::lock_guard<std::mutex> lock(g_mouse_mutex);
  // Relative mouse motion from the touch overlay in "mouse mode" is reported like a real mouse.
  if (g_mouse.dx || g_mouse.dy || g_mouse.wheel) {
    InputEvent e{};
    e.kind = InputEvent::MouseMove;
    e.dx = g_mouse.dx;
    e.dy = g_mouse.dy;
    out.push_back(e);
    if (g_mouse.wheel) {
      InputEvent w{};
      w.kind = InputEvent::MouseWheel;
      w.dy = g_mouse.wheel;
      out.push_back(w);
    }
    g_mouse.dx = g_mouse.dy = g_mouse.wheel = 0;
  }
}

const uint8_t* keyboard_state() { return g_keys; }

MouseState take_mouse_state() {
  std::lock_guard<std::mutex> lock(g_mouse_mutex);
  MouseState s = g_mouse;
  g_mouse.dx = g_mouse.dy = g_mouse.wheel = 0;
  return s;
}

void frame_presented(uint64_t frame) { (void)frame; }

// ---- Gamepads ----------------------------------------------------------------------------------

GamepadState gamepad_state(int slot) {
  // Pads are read straight from the Java side (Android MotionEvent / InputDevice), which forwards
  // them through `pad_event`; the state lives here so the HLE layer sees a normal DirectInput pad.
  return g_pads[slot & (kMaxGamepads - 1)];
}

void gamepad_rumble(int slot, float strong, float weak) {
  g_rumble[slot & (kMaxGamepads - 1)][0] = strong;
  g_rumble[slot & (kMaxGamepads - 1)][1] = weak;
}

// ---- GLES --------------------------------------------------------------------------------------

bool gl_create_context() {
  std::lock_guard<std::mutex> lock(g_window_mutex);
  if (!g_window) {
    LOGW("gl_create_context without a surface");
    return false;
  }
  if (g_display == EGL_NO_DISPLAY) {
    g_display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    if (g_display == EGL_NO_DISPLAY) {
      LOGW("eglGetDisplay failed");
      return false;
    }
    EGLint major = 0, minor = 0;
    if (!eglInitialize(g_display, &major, &minor)) {
      LOGW("eglInitialize failed");
      return false;
    }
    LOGI("EGL %d.%d", major, minor);
  }
  if (g_context == EGL_NO_CONTEXT) {
    // GLES 3.0 is the floor: the D3D9 fixed-function emulation uses 3.0 features (instancing,
    // texture arrays, integer varyings) and MSAA.
    EGLint count = 0;
    if (!eglChooseConfig(g_display, kMsaaConfigAttrs, &g_config, 1, &count) || count == 0) {
      // Not every device offers 4x MSAA on a window config: fall back to no multisampling.
      if (!eglChooseConfig(g_display, kConfigAttrs, &g_config, 1, &count) || count == 0) {
        LOGW("no GLES 3 EGL config");
        return false;
      }
      LOGI("MSAA unavailable, using a plain GLES 3 config");
    }
    const EGLint ctx_attrs[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
    g_context = eglCreateContext(g_display, g_config, EGL_NO_CONTEXT, ctx_attrs);
    if (g_context == EGL_NO_CONTEXT) {
      LOGW("eglCreateContext failed: 0x%x", eglGetError());
      return false;
    }
  }
  if (g_surface == EGL_NO_SURFACE) {
    // The config the context was created with is the one the window surface must use.
    const EGLint native_attrs[] = {EGL_NONE};
    EGLint count = 0;
    if (g_context == EGL_NO_CONTEXT || !eglChooseConfig(g_display, kConfigAttrs, &g_config, 1, &count)) {
      LOGW("eglChooseConfig failed before creating a surface");
      return false;
    }
    g_surface = eglCreateWindowSurface(g_display, g_config, g_window, native_attrs);
    if (g_surface == EGL_NO_SURFACE) {
      LOGW("eglCreateWindowSurface failed: 0x%x", eglGetError());
      return false;
    }
  }
  if (!eglMakeCurrent(g_display, g_surface, g_surface, g_context)) {
    LOGW("eglMakeCurrent failed: 0x%x", eglGetError());
    return false;
  }
  LOGI("GLES %s", (const char*)glGetString(GL_VERSION));
  LOGI("renderer %s", (const char*)glGetString(GL_RENDERER));
  return true;
}

void gl_swap() {
  if (g_surface != EGL_NO_SURFACE) eglSwapBuffers(g_display, g_surface);
}

void gl_set_swap_interval(int interval) {
  if (g_display != EGL_NO_DISPLAY && g_surface != EGL_NO_SURFACE) {
    eglSwapInterval(g_display, interval);
  }
}

// ---- Audio -------------------------------------------------------------------------------------

bool audio_open(int rate, void (*render)(float* out, int frames)) {
  g_audio.render = render;
  g_audio.rate = rate;
  AAudioStreamBuilder* builder = nullptr;
  if (aaudio_createStreamBuilder(&builder) != AAUDIO_OK) {
    LOGW("aaudio_createStreamBuilder failed");
    return false;
  }
  aaudio_stream_builder_setDirection(builder, AAUDIO_DIRECTION_OUTPUT);
  aaudio_stream_builder_setFormat(builder, AAUDIO_FORMAT_PCM_FLOAT);
  aaudio_stream_builder_setSampleRate(builder, rate);
  aaudio_stream_builder_setChannelCount(builder, 2);
  aaudio_stream_builder_setPerformanceMode(builder, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
  // 1024 frames keeps latency near 20 ms at 48 kHz while leaving the mixer enough slack to never
  // underrun on a busy frame; the mixer itself renders in fixed 256-frame tiles.
  aaudio_stream_builder_setBufferCapacityInFrames(builder, 4096);
  aaudio_stream_builder_setDataCallback(builder, audio_callback, nullptr);
  aaudio_result_t err = aaudio_stream_builder_build(builder, &g_audio.stream);
  aaudio_stream_builder_delete(builder);
  if (err != AAUDIO_OK) {
    LOGW("AAudio build failed: %s", AAudio_convertResultToText(err));
    return false;
  }
  err = aaudio_stream_request_start(g_audio.stream);
  if (err != AAUDIO_OK) {
    LOGW("AAudio start failed: %s", AAudio_convertResultToText(err));
    return false;
  }
  LOGI("audio: %d Hz, %d channels", rate, 2);
  return true;
}

}  // namespace plat

// ---- JNI surface used by the Java activity -----------------------------------------------------

extern "C" {

JNIEXPORT void JNICALL Java_org_shrek2_launcher_GameActivity_nativeSetSurface(JNIEnv* env, jclass, jobject surface) {
  std::lock_guard<std::mutex> lock(plat::g_window_mutex);
  if (plat::g_window) {
    ANativeWindow_release(plat::g_window);
    plat::g_window = nullptr;
  }
  if (plat::g_surface != EGL_NO_SURFACE) {
    eglMakeCurrent(plat::g_display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    eglDestroySurface(plat::g_display, plat::g_surface);
    plat::g_surface = EGL_NO_SURFACE;
  }
  if (surface) {
    plat::g_window = ANativeWindow_fromSurface(env, surface);
    plat::g_width = ANativeWindow_getWidth(plat::g_window);
    plat::g_height = ANativeWindow_getHeight(plat::g_window);
  }
}

JNIEXPORT void JNICALL Java_org_shrek2_launcher_GameActivity_nativeSurfaceSize(JNIEnv*, jclass, jint w, jint h) {
  std::lock_guard<std::mutex> lock(plat::g_window_mutex);
  plat::g_width = w;
  plat::g_height = h;
}

// A virtual key from the touch overlay or a physical keyboard: `vk` is a Win32 virtual-key code.
JNIEXPORT void JNICALL Java_org_shrek2_launcher_GameActivity_nativeKey(JNIEnv*, jclass, jint vk, jint action) {
  using namespace plat;
  const bool down = action != 0;  // 0 = up, 1 = down, 2 = repeat
  // A virtual pad button is not a key: fold it into the pad state the HLE layer reads, so the game
  // sees one controller no matter whether the input came from a pad or from the screen.
  if (const uint32_t bit = virtualPadButton((uint32_t)vk)) {
    GamepadState& pad = g_pads[0];
    pad.connected = true;
    pad.buttons = down ? (pad.buttons | bit) : (pad.buttons & ~bit);
    return;
  }
  const uint32_t dik = scancodeFor(vk);
  InputEvent e{};
  e.kind = down ? InputEvent::KeyDown : InputEvent::KeyUp;
  e.vk = (uint32_t)vk;
  e.scancode = dik;
  e.repeat = action == 2;
  set_key(dik, down);
  push(e);
}

JNIEXPORT void JNICALL Java_org_shrek2_launcher_GameActivity_nativePad(JNIEnv*, jclass, jint slot, jint what,
                                                                      jfloat a, jfloat b) {
  using namespace plat;
  if (slot < 0 || slot >= kMaxGamepads) return;
  GamepadState& pad = g_pads[slot];
  pad.connected = true;
  switch (what) {
    case 0:  // button bitfield
      pad.buttons = (uint32_t)a;
      break;
    case 1:  // left stick
      pad.lx = a;
      pad.ly = b;
      break;
    case 2:  // right stick
      pad.rx = a;
      pad.ry = b;
      break;
    case 3:  // triggers
      pad.lt = a;
      pad.rt = b;
      break;
    case 4:  // connected / disconnected
      pad.connected = a != 0;
      break;
    default:
      break;
  }
}

JNIEXPORT void JNICALL Java_org_shrek2_launcher_GameActivity_nativeFocus(JNIEnv*, jclass, jboolean focused) {
  using namespace plat;
  g_focused = focused != 0;
  InputEvent e{};
  e.kind = g_focused ? InputEvent::FocusGained : InputEvent::FocusLost;
  if (!g_focused) memset(g_keys, 0, sizeof g_keys);  // nothing stays held while we are in the background
  push(e);
}

JNIEXPORT void JNICALL Java_org_shrek2_launcher_GameActivity_nativeMouseMove(JNIEnv*, jclass, jfloat dx, jfloat dy) {
  std::lock_guard<std::mutex> lock(plat::g_mouse_mutex);
  plat::g_mouse.dx += (int32_t)dx;
  plat::g_mouse.dy += (int32_t)dy;
}

JNIEXPORT void JNICALL Java_org_shrek2_launcher_GameActivity_nativeMouseButton(JNIEnv*, jclass, jint button,
                                                                             jint action) {
  using namespace plat;
  if (button < 0 || button > 3) return;
  const bool down = action != 0;
  {
    std::lock_guard<std::mutex> lock(g_mouse_mutex);
    g_mouse.buttons[button] = down ? 1 : 0;
  }
  InputEvent e{};
  e.kind = down ? InputEvent::MouseDown : InputEvent::MouseUp;
  e.button = (uint32_t)button;
  push(e);
}

// Absolute pointer position, used when the game runs a software cursor (menus).
JNIEXPORT void JNICALL Java_org_shrek2_launcher_GameActivity_nativeMouseTo(JNIEnv*, jclass, jint x, jint y) {
  plat::InputEvent e{};
  e.kind = plat::InputEvent::MouseMove;
  e.x = x;
  e.y = y;
  plat::push(e);
}

JNIEXPORT void JNICALL Java_org_shrek2_launcher_GameActivity_nativeQuit() {
  plat::InputEvent e{};
  e.kind = plat::InputEvent::Quit;
  plat::push(e);
}

}  // extern "C"

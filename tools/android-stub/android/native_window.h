// Minimal <android/native_window.h> for the host-side syntax check.
#pragma once
#include <cstdint>
struct ANativeWindow;
typedef struct ANativeWindow ANativeWindow;
inline int32_t ANativeWindow_getWidth(ANativeWindow*) { return 0; }
inline int32_t ANativeWindow_getHeight(ANativeWindow*) { return 0; }
inline void ANativeWindow_release(ANativeWindow*) {}
inline int32_t ANativeWindow_setBuffersGeometry(ANativeWindow*, int32_t, int32_t, int32_t) { return 0; }

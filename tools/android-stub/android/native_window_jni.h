// Minimal <android/native_window_jni.h> for the host-side syntax check.
#pragma once
#include "native_window.h"
#include "jni.h"
inline ANativeWindow* ANativeWindow_fromSurface(JNIEnv*, jobject) { return nullptr; }

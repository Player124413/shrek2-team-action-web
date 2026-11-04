// Minimal JNI declarations for the host-side syntax check (tools/android-check.sh).
// Not used by the Android build, which gets the real header from the NDK.
#pragma once
#include <cstdint>

typedef int32_t jint;
typedef int64_t jlong;
typedef uint8_t jboolean;
typedef float jfloat;
typedef double jdouble;
typedef jint jsize;
typedef unsigned char jbyte;

#define JNI_TRUE 1
#define JNI_FALSE 0
#define JNIEXPORT __attribute__((visibility("default")))
#define JNICALL

struct _jobject {};
typedef _jobject* jobject;
typedef jobject jclass;
typedef jobject jstring;
typedef jobject jarray;
typedef jarray jbyteArray;

// In C++ the real jni.h gives JNIEnv member functions (`env->NewStringUTF(...)`), so the stub does too.
struct JNIEnv {
  jint GetVersion();
  jclass FindClass(const char* name);
  const char* GetStringUTFChars(jstring s, jboolean* isCopy);
  void ReleaseStringUTFChars(jstring s, const char* chars);
  jsize GetStringUTFLength(jstring s);
  jint GetArrayLength(jarray a);
  void* GetPrimitiveArrayCritical(jarray a, jboolean* isCopy);
  void ReleasePrimitiveArrayCritical(jarray a, void* data, jint mode);
  jint ThrowNew(jclass clazz, const char* msg);
};

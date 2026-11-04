// Minimal <android/log.h> for the host-side syntax check.
#pragma once
#include <cstdarg>
#include <cstdio>

typedef enum android_LogPriority {
  ANDROID_LOG_UNKNOWN = 0, ANDROID_LOG_DEFAULT, ANDROID_LOG_VERBOSE, ANDROID_LOG_DEBUG,
  ANDROID_LOG_INFO, ANDROID_LOG_WARN, ANDROID_LOG_ERROR, ANDROID_LOG_FATAL, ANDROID_LOG_SILENT,
} android_LogPriority;

inline int __android_log_print(int, const char* tag, const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  std::fprintf(stderr, "%s: ", tag);
  std::vfprintf(stderr, fmt, ap);
  std::fputc('\n', stderr);
  va_end(ap);
  return 0;
}
#define __android_log_write(prio, tag, text) __android_log_print(prio, tag, "%s", text)

// Fills the app's private install directory from content the launcher hands over.
//
// The Java side copies *files* (a whole disc image, or an already installed directory) and calls
// `NativeInstall.copyFile` / `NativeInstall.finish` here; the guest runtime only ever sees a normal
// `install/Game/...` tree, exactly like the desktop build's `--install` directory (vfs_init in
// core/objects.cpp maps the guest's C:\Games\Shrek 2 Team Action\Game onto it).
//
// Installing from an ISO image is done by the same TypeScript installer the web build uses
// (installer/src/install.ts): run it under Node or in the launcher's WebView and write the resulting
// files here with `copyFile`. Keeping the ISO parser out of the app avoids a second, untested
// implementation of the CDFS/CAB/CFB decoders.
#include <jni.h>
#include <sys/stat.h>

#include <cerrno>

#include <cstdio>
#include <cstring>
#include <string>

namespace {

bool copy_into(const std::string& from, const std::string& to) {
  FILE* in = fopen(from.c_str(), "rb");
  if (!in) return false;
  FILE* out = fopen(to.c_str(), "wb");
  if (!out) {
    fclose(in);
    return false;
  }
  char buf[1 << 16];
  size_t n;
  bool ok = true;
  while ((n = fread(buf, 1, sizeof buf, in)) > 0) {
    if (fwrite(buf, 1, n, out) != n) {
      ok = false;
      break;
    }
  }
  fclose(in);
  if (fclose(out) != 0) ok = false;
  return ok;
}

/** Creates every component of `path` (directories only), like `mkdir -p`. */
bool make_dirs(const std::string& path) {
  for (size_t i = 1; i <= path.size(); i++) {
    if (i == path.size() || path[i] == '/') {
      const std::string part = path.substr(0, i);
      if (mkdir(part.c_str(), 0755) != 0 && errno != EEXIST) return false;
    }
  }
  return true;
}

std::string join(const std::string& root, const std::string& rel) { return root + "/" + rel; }

}  // namespace

// `InstallFiles.isEmpty()` in Kotlin mirrors these: the launcher checks for the executable before it
// starts the game, so a half-finished install shows the installer instead of a fatal error.
extern "C" {

JNIEXPORT jboolean JNICALL Java_org_shrek2_launcher_InstallFiles_installed(JNIEnv* env, jclass, jstring root) {
  const char* utf = env->GetStringUTFChars(root, nullptr);
  const std::string path = std::string(utf) + "/install/Game/Shrek 2.exe";
  env->ReleaseStringUTFChars(root, utf);
  FILE* f = fopen(path.c_str(), "rb");
  if (!f) return JNI_FALSE;
  fclose(f);
  return JNI_TRUE;
}

/** Copies one file of the install tree; `rel` is guest-relative ("Game/Shrek 2.exe"). */
JNIEXPORT jboolean JNICALL Java_org_shrek2_launcher_InstallFiles_copyFile(JNIEnv* env, jclass, jstring root,
                                                                         jstring rel, jstring from) {
  const char* r = env->GetStringUTFChars(root, nullptr);
  const char* p = env->GetStringUTFChars(rel, nullptr);
  const char* s = env->GetStringUTFChars(from, nullptr);
  const std::string dest = join(join(r, "install"), p);
  const std::string dir = dest.substr(0, dest.find_last_of('/'));
  const bool ok = make_dirs(join(r, "install")) && make_dirs(dir) && copy_into(s, dest);
  env->ReleaseStringUTFChars(root, r);
  env->ReleaseStringUTFChars(rel, p);
  env->ReleaseStringUTFChars(from, s);
  return ok ? JNI_TRUE : JNI_FALSE;
}

/** Everything is in place: create the writable folders the game expects and drop the marker. */
JNIEXPORT jboolean JNICALL Java_org_shrek2_launcher_InstallFiles_finish(JNIEnv* env, jclass, jstring root) {
  const char* r = env->GetStringUTFChars(root, nullptr);
  const std::string install = std::string(r) + "/install";
  const bool ok = make_dirs(install + "/Game/Save") && make_dirs(std::string(r) + "/cache");
  env->ReleaseStringUTFChars(root, r);
  return ok ? JNI_TRUE : JNI_FALSE;
}

}  // extern "C"

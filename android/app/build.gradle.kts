import java.util.Properties

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

/**
 * Signing.
 *
 * "Updating the app must not wipe the player's game" is a signing property, not a code one: Android
 * only replaces an installed app when the new APK carries the *same* signing key and a higher
 * versionCode. So every APK this project ships is signed, and always with the same key:
 *
 *   1. the release key, when it is configured -- android/keystore.properties (git-ignored, local) or
 *      the SHREK2_KEYSTORE* environment variables (CI, from secrets);
 *   2. otherwise the *committed* debug key (android/debug.keystore, password "android"), the same in
 *      every checkout and on every runner. A fresh key would change with each build and every install
 *      would be "app not installed: the package appears to be corrupt" or an update that needs an
 *      uninstall. This is the default, so a build straight out of CI installs and updates in place.
 *
 * Debug and release variants use the same key and the same package on purpose: a debug build replaces
 * the installed game instead of sitting next to it, and switching to the release key later is still an
 * update, not a different app. `--debug` only changes debuggability.
 *
 * See android/README.md ("Updating in place") for how the release key is created and kept.
 */
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
  if (keystorePropertiesFile.isFile) keystorePropertiesFile.inputStream().use { load(it) }
}
fun signingValue(key: String, env: String): String? =
  (keystoreProperties.getProperty(key) ?: System.getenv(env))?.takeIf { it.isNotBlank() }

/** The release key, when one is configured; null means "fall back to the committed debug key". */
val releaseStoreFile = signingValue("storeFile", "SHREK2_KEYSTORE")

/** The debug key shipped with the project; see the comment above. */
val debugKeystore = rootProject.file("debug.keystore")
require(debugKeystore.isFile) {
  "android/debug.keystore is missing: without it every APK would be signed with a different key, and " +
    "installed copies could not be updated. It is committed on purpose (see android/README.md)."
}

android {
  signingConfigs {
    // Always present, so no build type can end up unsigned (an unsigned APK cannot be installed at all).
    create("release") {
      if (releaseStoreFile != null) {
        // Relative to android/, where keystore.properties lives.
        storeFile = rootProject.file(releaseStoreFile)
        storePassword = signingValue("storePassword", "SHREK2_KEYSTORE_PASSWORD")
        keyAlias = signingValue("keyAlias", "SHREK2_KEY_ALIAS")
        keyPassword = signingValue("keyPassword", "SHREK2_KEY_PASSWORD")
      } else {
        storeFile = debugKeystore
        storePassword = "android"
        keyAlias = "androiddebugkey"
        keyPassword = "android"
      }
      // v1 is not needed for Android 8+; v2/v3 are what keep an update "the same app".
      enableV1Signing = false
      enableV2Signing = true
      enableV3Signing = true
    }
    create("debugkey") {
      // Same key as the default: debug and release builds replace each other in place.
      storeFile = debugKeystore
      storePassword = "android"
      keyAlias = "androiddebugkey"
      keyPassword = "android"
      enableV1Signing = false
      enableV2Signing = true
      enableV3Signing = true
    }
  }

  namespace = "org.shrek2.launcher"
  compileSdk = 35
  ndkVersion = "27.0.12077973"

  defaultConfig {
    applicationId = "org.shrek2.launcher"
    // GLES 3.0 + AAudio (low-latency stream builder): Android 8.0.
    minSdk = 26
    targetSdk = 35
    // `versionCode` must strictly increase for Android to *update* an installed app: an equal or lower
    // code is rejected by the installer, exactly like a different signing key. Both come from
    // tools/android-version.sh (git tags + commit count) via .github/workflows/android.yml; the
    // fallbacks only matter for a build started by hand without the wrapper script.
    versionCode = (System.getenv("SHREK2_VERSION_CODE") ?: "1").toInt().also {
      require(it > 0) { "SHREK2_VERSION_CODE must be positive, got $it" }
    }
    versionName = System.getenv("SHREK2_VERSION_NAME") ?: "0.1"

    ndk {
      // The AOT compiler emits AArch64 only, and the runtime is built for arm64-v8a.
      abiFilters += listOf("arm64-v8a")
    }

    externalNativeBuild {
      cmake {
        cppFlags += listOf("-std=c++20", "-O2")
        // Optimised native code even in the debug-variant CMake build: the interpreter is the hot path.
        arguments += listOf("-DCMAKE_BUILD_TYPE=RelWithDebInfo")
      }
    }
  }

  externalNativeBuild {
    cmake {
      path = file("src/main/cpp/CMakeLists.txt")
      version = "3.22.1"
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      // Signed even without a release key: with the project's debug key, so it installs and updates.
      signingConfig = signingConfigs.getByName("release")
    }
    debug {
      // The same package as the release build and the same key, so a debug build updates the installed
      // game instead of sitting next to it: the player keeps their install, saves and settings.
      signingConfig = signingConfigs.getByName("debugkey")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }

  // The AOT image and the side table are produced by `node aot/cli.ts image` and placed here; they
  // are not modified afterwards, so keep them uncompressed in the APK: the loader mmaps the image
  // directly out of the asset instead of copying it through a buffer.
  androidResources {
    // `sk2a`/`skx`: the AOT image is mmapped out of the asset, so it must not be deflated.
    // `game`: the installed copy of the game packaged by tools/pack-game.mjs. Most of it is already
    // compressed (textures, audio, video), so deflating it would cost build time and save nothing, and a
    // stored entry is a plain read for AssetManager when the launcher unpacks it on first start.
    noCompress += listOf("sk2a", "skx")
    noCompress += listOf("game")
  }

  packaging {
    jniLibs {
      useLegacyPackaging = false
    }
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("androidx.games:games-activity:3.0.5")
}

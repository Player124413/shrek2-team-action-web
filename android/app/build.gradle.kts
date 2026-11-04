import java.util.Properties

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

/**
 * Release signing.
 *
 * "Updating the app must not wipe the player's game" is a signing property, not a code one: Android
 * only replaces an installed app when the new APK carries the *same* signing key and a higher
 * versionCode. So the release build always uses one stable keystore:
 *
 *   1. android/keystore.properties (git-ignored) if it exists -- what a local machine uses;
 *   2. the SHREK2_KEYSTORE / SHREK2_KEYSTORE_PASSWORD / SHREK2_KEY_ALIAS / SHREK2_KEY_PASSWORD
 *      environment variables -- what CI uses, and where the keystore + password come from secrets;
 *   3. otherwise an unsigned build is produced (a debug-signed APK can never update a release one).
 *
 * See android/README.md ("Updating in place") for how the key is created and kept.
 */
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
  if (keystorePropertiesFile.isFile) keystorePropertiesFile.inputStream().use { load(it) }
}
fun signingValue(key: String, env: String): String? =
  keystoreProperties.getProperty(key) ?: System.getenv(env)

val releaseStoreFile = signingValue("storeFile", "SHREK2_KEYSTORE")

android {
  signingConfigs {
    if (releaseStoreFile != null) {
      create("release") {
        // Relative to android/, where keystore.properties lives.
        storeFile = rootProject.file(releaseStoreFile)
        storePassword = signingValue("storePassword", "SHREK2_KEYSTORE_PASSWORD")
        keyAlias = signingValue("keyAlias", "SHREK2_KEY_ALIAS")
        keyPassword = signingValue("keyPassword", "SHREK2_KEY_PASSWORD")
        // v1 is not needed for Android 8+; v2/v3 are what keep an update "the same app".
        enableV1Signing = false
        enableV2Signing = true
        enableV3Signing = true
      }
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
      if (releaseStoreFile != null) signingConfig = signingConfigs.getByName("release")
    }
    debug {
      // A debug build installs side by side with a release one but cannot update it: different key.
      applicationIdSuffix = ".debug"
      versionNameSuffix = "-debug"
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
    noCompress += listOf("sk2a", "skx")
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

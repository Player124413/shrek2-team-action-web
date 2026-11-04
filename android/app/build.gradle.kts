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

val storeFilePath = signingValue("storeFile", "SHREK2_KEYSTORE")
val releaseSigning = storeFilePath?.let { path ->
  signingConfigs.create("release") {
    storeFile = file(path)
    storePassword = signingValue("storePassword", "SHREK2_KEYSTORE_PASSWORD")
    keyAlias = signingValue("keyAlias", "SHREK2_KEY_ALIAS")
    keyPassword = signingValue("keyPassword", "SHREK2_KEY_PASSWORD")
    // v1 is not needed for Android 8+; v2/v3 are what keep an update "the same app".
    enableV1Signing = false
    enableV2Signing = true
    enableV3Signing = true
  }
}

android {
  namespace = "org.shrek2.launcher"
  compileSdk = 35
  ndkVersion = "27.0.12077973"

  defaultConfig {
    applicationId = "org.shrek2.launcher"
    // GLES 3.0 + AAudio (low-latency stream builder): Android 8.0.
    minSdk = 26
    targetSdk = 35
    // `versionCode` must increase for Android to *update* an installed app (an equal or lower code is
    // rejected by the installer, and a different signing key is rejected outright). CI overrides both
    // from the git tag / run number; see .github/workflows/android.yml.
    versionCode = (System.getenv("SHREK2_VERSION_CODE") ?: "1").toInt()
    versionName = System.getenv("SHREK2_VERSION_NAME") ?: "0.1"

    ndk {
      // The AOT compiler emits AArch64 only, and the runtime is built for arm64-v8a.
      abiFilters += listOf("arm64-v8a")
    }

    externalNativeBuild {
      cmake {
        cppFlags += listOf("-std=c++20", "-O2")
        // Guest addresses up to 1 GiB must be reachable from a 32-bit guest pointer: keep the guest
        // window in the low 4 GiB of the process (the runtime mmaps it at a fixed address).
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
      if (releaseSigning != null) signingConfig = releaseSigning
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

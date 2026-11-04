plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
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
    versionCode = 1
    versionName = "0.1"

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

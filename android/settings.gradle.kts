// Android port of the runtime: the game's own executable and data come from the install directory,
// guest code comes from the AOT image built on the device (aot/), and everything else is the same
// C++ runtime the desktop and web builds use.
pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "shrek2"
include(":app")

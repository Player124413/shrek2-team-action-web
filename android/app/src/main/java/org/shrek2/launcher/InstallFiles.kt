package org.shrek2.launcher

import android.content.Context
import java.io.File

/**
 * The install directory, as seen from Java.
 *
 * The layout is the desktop build's: `files/install/Game/Shrek 2.exe` and its data, `files/cache/`
 * for the AOT image, `files/registry.txt` for the game's settings (written by the HLE Advapi32 layer).
 * Filling it is the job of the installer; this object only reports state and creates the folders.
 */
object InstallFiles {

  /** Relative path of the executable, the marker every other file is optional around. */
  const val GAME_EXE = "Game/Shrek 2.exe"

  fun installDir(context: Context): File = File(context.filesDir, "install")

  fun cacheDir(context: Context): File = File(context.filesDir, "cache")

  /** True once the game's own executable is present: the launcher shows the game instead of the wizard. */
  fun installed(context: Context): Boolean = File(installDir(context), GAME_EXE).isFile

  /** True once the AOT image has been built for the installed executable (`node aot/cli.ts image`). */
  fun compiled(context: Context): Boolean = File(cacheDir(context), "game.sk2a").isFile

  /**
   * Copies the AOT image that was packaged with the APK into the cache directory, the only place the
   * native loader reads it from. Doing it here keeps the C++ side free of asset APIs and means the
   * image is copied exactly once (a rebuild of the APK replaces it).
   */
  fun unpackImage(context: Context): Boolean {
    val target = cacheDir(context).apply { mkdirs() }
    var ok = true
    for (name in listOf("game.sk2a", "game.skx")) {
      val out = File(target, name)
      if (out.isFile && out.length() > 0) continue
      ok = runCatching {
        context.assets.open(name).use { input -> out.outputStream().use { input.copyTo(it) } }
        true
      }.getOrDefault(false) && ok
    }
    return ok && File(target, "game.sk2a").isFile
  }

  fun prepare(context: Context): Boolean {
    installDir(context).mkdirs()
    cacheDir(context).mkdirs()
    return installed(context)
  }

  /** Size of the AOT image in bytes, or 0 when the game has not been compiled yet. */
  fun imageBytes(context: Context): Long = File(cacheDir(context), "game.sk2a").let { if (it.isFile) it.length() else 0L }

  // Implemented in install_files.cpp: the copy and the marker live next to the runtime so the layout
  // has exactly one definition.

  /** Copies `from` to `<root>/install/<rel>`, creating directories as needed. */
  external fun copyFile(root: String, rel: String, from: String): Boolean

  /** Creates `Game/Save` and `cache/` once every file has been copied. */
  external fun finish(root: String): Boolean

  private val loaded: Unit = System.loadLibrary("shrek2")
}

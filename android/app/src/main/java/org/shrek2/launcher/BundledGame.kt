package org.shrek2.launcher

import android.content.Context
import java.io.File

/**
 * The game files packaged inside the APK (`assets/game/`, written by `tools/pack-game.mjs`).
 *
 * Installing from the player's own disc image is one way to get the game onto the phone; this is the
 * other, and the simpler one for the player: the APK already carries an installed copy, so "Play" works
 * after the install with nothing to pick and nothing to copy.
 *
 * The files go to the same place a disc install writes them (`noBackupFilesDir/install/`), so the game
 * code, the settings and the AOT image do not care where they came from -- and an APK update keeps them
 * (an update never touches `noBackupFilesDir`). Unpacking is guarded by a stamp holding the folder digest
 * and the file count, so it happens on the first start and after an APK that carries a different tree, not
 * on every launch.
 *
 * The APK is built with the tree uncompressed (see `noCompress` in `app/build.gradle.kts`), because most
 * of it is already-compressed game data and `AssetManager.open` on a stored entry is a plain read.
 */
object BundledGame {

  /** Where the packer puts the tree inside the APK. */
  private const val ROOT = "game"

  private const val STAMP = "stamp.txt"
  private const val INDEX = "index.txt"

  /** True when this APK carries a game at all (a fork built without one does not). */
  fun bundled(context: Context): Boolean = runCatching {
    context.assets.open("$ROOT/$STAMP").use { true }
  }.getOrDefault(false)

  /** `<folder md5> <files> <bytes>`, or null when this APK carries no game. */
  fun stamp(context: Context): String? = runCatching {
    context.assets.open("$ROOT/$STAMP").bufferedReader().readLine()?.trim()
  }.getOrNull()?.takeIf { it.isNotEmpty() }

  /**
   * Copy the packaged game into the install directory.
   *
   * [onProgress] gets (files written, files total). Files are written to a temporary name and renamed, so a
   * process that dies half-way never leaves a file that looks complete; the stamp is written last and is
   * what marks the tree as whole. Returns true when the install directory holds the packaged tree.
   */
  fun unpack(context: Context, onProgress: (Int, Int) -> Unit = { _, _ -> }): Boolean {
    val wanted = stamp(context) ?: return false
    val root = InstallFiles.installDir(context)
    val marker = File(root, ".bundled")
    if (marker.isFile && marker.readText().trim() == wanted && InstallFiles.installed(context)) return true

    val entries = runCatching {
      context.assets.open("$ROOT/$INDEX").bufferedReader().useLines { lines ->
        lines.mapNotNull { line ->
          val tab = line.indexOf('\t')
          if (tab <= 0) null else line.substring(0, tab).toLongOrNull() to line.substring(tab + 1)
        }.toList()
      }
    }.getOrNull() ?: return false
    if (entries.isEmpty()) return false

    root.mkdirs()
    var done = 0
    for ((size, path) in entries) {
      // The names come from the packer, but they end up in a path: refuse anything that tries to escape.
      if (path.startsWith("/") || path.contains("..") || path.contains('\\')) continue
      val out = File(root, path)
      val dir = out.parentFile
      if (dir != null && !dir.isDirectory && !dir.mkdirs()) throw java.io.IOException("cannot create $dir")
      val tmp = File(dir, out.name + ".part")
      context.assets.open("$ROOT/$path").use { input ->
        tmp.outputStream().use { sink ->
          val buffer = ByteArray(1 shl 20)
          var written = 0L
          while (true) {
            val n = input.read(buffer)
            if (n <= 0) break
            sink.write(buffer, 0, n)
            written += n
          }
          if (written != size) throw java.io.IOException("$path: ${written} bytes, expected $size")
        }
      }
      if (out.exists() && !out.delete()) throw java.io.IOException("cannot replace $path")
      if (!tmp.renameTo(out)) throw java.io.IOException("cannot write $path")
      done++
      onProgress(done, entries.size)
    }
    marker.writeText(wanted)
    return true
  }
}

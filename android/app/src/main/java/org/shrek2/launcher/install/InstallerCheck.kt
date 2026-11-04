package org.shrek2.launcher.install

import java.io.File

/**
 * Runs the Android installer over the conformance corpus and prints what it produced.
 *
 * The corpus (`runtime/test/cab-lzx-corpus.mjs`) is a synthetic disc-shaped ISO 9660 image holding an MSI
 * database and an LZX cabinet, laid out like the retail disc. Its manifest records the MD5 of every file,
 * and the generator only writes it after the *reference* installer (`installer/src`) has installed the
 * same image byte-for-byte. So if this program reproduces the manifest, the Kotlin port agrees with the
 * implementation the web build ships.
 *
 * It is a plain `main` on purpose: no Android framework, no JUnit, so `tools/installer-test.sh` can run it
 * on any machine with a JDK. Paths come from the arguments, never from `Context`.
 *
 *   InstallerCheck <corpus dir>
 */
object InstallerCheck {

  @JvmStatic
  fun main(args: Array<String>) {
    val dir = File(args.firstOrNull() ?: error("usage: InstallerCheck <corpus dir>"))
    val iso = File(dir, "shrek2.iso")
    require(iso.isFile) { "no ${iso.path}: run node runtime/test/cab-lzx-corpus.mjs first" }
    val manifest = readManifest(File(dir, "manifest.json"))
    val out = File(dir, "install").apply {
      deleteRecursively()
      mkdirs()
    }

    var problems = 0
    fun fail(message: String) {
      problems++
      System.err.println("FAILED: $message")
    }

    val sink = DirSink(out)
    val started = System.nanoTime()
    val source = FileSource(iso)
    try {
      val disc = Installer.openDisc(source)
      if (disc.layout.productName != Installer.PRODUCT_NAME) fail("product name is ${disc.layout.productName}")
      if (disc.image.volumeId != manifest.volumeId) fail("volume id is ${disc.image.volumeId}")
      val report = Installer.install(disc, sink)
      val ms = (System.nanoTime() - started) / 1_000_000
      println("installed ${report.written} files, ${report.bytes} bytes from ${report.volumeId} in $ms ms")
      if (report.mismatches.isNotEmpty()) report.mismatches.forEach { fail("installer reported $it") }
      if (report.written != manifest.files.size) fail("wrote ${report.written} files, manifest has ${manifest.files.size}")

      // Every file: present, the right size, and the right MD5 (the first check would be satisfied by a
      // truncated file with matching size only if the digest matched, which is the point).
      for (f in manifest.files) {
        val file = File(out, f.path)
        if (!file.isFile) {
          fail("${f.path} is missing")
          continue
        }
        if (file.length() != f.size) fail("${f.path}: ${file.length()} bytes, expected ${f.size}")
        val got = Md5.hex(Md5.digest(file.readBytes()))
        if (got != f.md5) fail("${f.path}: md5 $got, expected ${f.md5}")
      }
      // No stray files: a wrong directory mapping would show up as one.
      val written = out.walkTopDown().filter { it.isFile }.map { it.relativeTo(out).path.replace(File.separatorChar, '/') }.toSet()
      val expected = manifest.files.map { it.path }.toSet()
      for (path in written - expected) fail("unexpected file $path")
      for (path in expected - written) fail("missing file $path")
    } finally {
      source.close()
    }

    if (problems == 0) {
      println("ok: the Kotlin installer reproduces the corpus (${manifest.files.size} files, folder md5 ${manifest.folderMd5})")
      return
    }
    println("FAILED ($problems problems)")
    kotlin.system.exitProcess(1)
  }

  private class Entry(val path: String, val size: Long, val md5: String)

  private class Manifest(val volumeId: String, val folderMd5: String, val files: List<Entry>)

  /**
   * A tiny JSON reader for the manifest this project writes (fixed shape, ASCII paths, no escapes). A
   * full parser would be a dependency, and a test helper is not the place to add one.
   */
  private fun readManifest(file: File): Manifest {
    val text = file.readText()
    val volumeId = Regex("\"volumeId\"\\s*:\\s*\"([^\"]*)\"").find(text)?.groupValues?.get(1) ?: ""
    val folderMd5 = Regex("\"folderMd5\"\\s*:\\s*\"([^\"]*)\"").find(text)?.groupValues?.get(1) ?: ""
    val files = Regex("\\{\\s*\"path\"\\s*:\\s*\"([^\"]*)\"\\s*,\\s*\"size\"\\s*:\\s*(\\d+)\\s*,\\s*\"md5\"\\s*:\\s*\"([0-9a-f]{32})\"\\s*}")
      .findAll(text)
      .map { Entry(it.groupValues[1], it.groupValues[2].toLong(), it.groupValues[3]) }
      .toList()
    require(files.isNotEmpty()) { "${file.path}: no file entries found" }
    return Manifest(volumeId, folderMd5, files)
  }
}

package org.shrek2.launcher

import java.io.OutputStream
import java.util.zip.GZIPInputStream
import org.shrek2.launcher.install.ByteSource
import org.shrek2.launcher.install.FileSink

/**
 * Unpacks an installed copy of the game from an archive the player picked: a `.zip`, a `.tar`, or a
 * `.tar.gz`/`.tgz`.
 *
 * This is the middle path between "pick a disc image" (the disc, a 548 MB installer run) and "the game is
 * built into the APK" (nothing to pick): the player zips their installed folder and the launcher unpacks
 * it. Both formats are read here rather than with `ZipInputStream`/`ZipFile`, which cannot take a range
 * reader -- and the file is a `content://` document that must not be copied to the cache first.
 *
 * The archive is not trusted with paths: entries are normalised and anything that would land outside the
 * install directory (`..`, an absolute path) is an error, not a silent skip. Files whose name is not
 * needed by the game are skipped by [include] (archives made on Windows often carry `Thumbs.db`,
 * `desktop.ini`, `.DS_Store`); the caller gets a count so it can say "unpacked 412 files".
 */
object ArchiveUnpacker {

  class Result(val files: Int, val bytes: Long, val skipped: Int, val format: String)

  /** What the installer needs plus what a launcher folder carries; everything else may be dropped. */
  private val JUNK = listOf("thumbs.db", "desktop.ini", ".ds_store", "ehthumbs.db", "autorun.inf")

  /**
   * The install root has to hold `Game/` itself, but the player's archive usually holds one more folder
   * (`Shrek 2 Team Action/Game/...`) — or none at all (`Game/...`). Both become `Game/...`; a file that
   * merely *contains* "game" (say `MyGame/...`) is left where it is.
   */
  private fun stripToGame(name: String): String {
    val lower = name.lowercase()
    val at = lower.indexOf("game/")
    if (at < 0) return name
    if (at != 0 && lower[at - 1] != '/') return name
    return name.substring(at)
  }

  private fun isJunk(name: String): Boolean {
    val base = name.substringAfterLast('/').lowercase()
    return JUNK.any { base == it } || base.startsWith("._")
  }

  /** Normalise an entry name to a path relative to the install root; null means "skip it". */
  private fun normalise(raw: String, base: String): String? {
    var name = raw.replace('\\', '/')
    // Many archives carry a top-level folder (`Shrek 2 Team Action/Game/...`). Kill the part before the
    // directory that holds the game, so the install root ends up with `Game/` in it.
    if (base.isNotEmpty()) {
      val at = name.lowercase().indexOf(base.lowercase() + "/")
      if (at >= 0) name = name.substring(at + base.length + 1)
    }
    name = name.trimStart('/')
    if (name.isEmpty() || name.endsWith("/")) return null
    val parts = name.split('/')
    if (parts.any { it == ".." || it.isEmpty() }) return null
    if (parts.first().endsWith(":") || name.startsWith("__MACOSX")) return null
    return name
  }

  /** Does this archive hold a game? True when it contains the executable, wherever the game sits. */
  fun containsGame(entries: Sequence<String>): Boolean = entries.any { it.lowercase().endsWith("/game/shrek 2.exe") || it.lowercase() == "game/shrek 2.exe" }

  /**
   * Unpack [source] into [sink]. [onProgress] receives (files written, files seen so far, current name).
   *
   * The format is sniffed from the first bytes, so the picker does not have to be believed: a `.iso` that
   * is actually a tarball still works, and a wrong choice produces a sentence rather than a crash.
   */
  fun unpack(
    source: ByteSource,
    sink: FileSink,
    onProgress: (Int, Int, String) -> Unit = { _, _, _ -> },
  ): Result {
    val head = sniff(source)
    val gzip = hasSignature(head, 0x1f, 0x8b)
    val format = when {
      hasSignature(head, 0x50, 0x4b, 0x03, 0x04) -> "zip"
      gzip -> "tar.gz"
      else -> "tar"
    }
    if (format == "zip") return unzip(source, head, sink, onProgress)
    return untar(decompress(source, head), gzip = format == "tar.gz", sink = sink, onProgress = onProgress)
  }

  // ---- Sniffing ------------------------------------------------------------------------------------

  /** The first 512 bytes; enough for every signature and for the first tar header. */
  private fun sniff(source: ByteSource): ByteArray = source.read(0, minOf(512L, source.size).toInt())

  private fun hasSignature(b: ByteArray, vararg sig: Int): Boolean =
    b.size >= sig.size && sig.indices.all { (b[it].toInt() and 0xff) == sig[it] }

  /** The bytes an archive is read through: the whole file, or the file with its gzip wrapper removed. */
  private fun decompress(source: ByteSource, head: ByteArray): ByteSource {
    if (hasSignature(head, 0x1f, 0x8b)) {
      val gz = GZIPInputStream(SourceInputStream(source), 1 shl 20)
      val data = gz.use { it.readBytes() }
      return org.shrek2.launcher.install.MemorySource(data)
    }
    return source
  }

  /** A `java.io.InputStream` over a [ByteSource], for the gzip decoder. */
  private class SourceInputStream(private val source: ByteSource) : java.io.InputStream() {
    private var at = 0L
    override fun read(): Int {
      if (at >= source.size) return -1
      val b = source.read(at, 1)[0].toInt() and 0xff
      at += 1
      return b
    }
    override fun read(b: ByteArray, off: Int, len: Int): Int {
      if (len == 0) return 0
      if (at >= source.size) return -1
      val n = minOf(len.toLong(), source.size - at).toInt()
      System.arraycopy(source.read(at, n), 0, b, off, n)
      at += n
      return n
    }
  }

  // ---- zip -----------------------------------------------------------------------------------------

  private fun unzip(
    source: ByteSource,
    head: ByteArray,
    sink: FileSink,
    onProgress: (Int, Int, String) -> Unit,
  ): Result {
    // The end-of-central-directory record is in the last 64 KiB (22 bytes, plus a comment of up to 64 KiB).
    val tailAt = maxOf(0L, source.size - 66_000)
    val tail = source.read(tailAt, (source.size - tailAt).toInt())
    var eocd = -1
    var i = tail.size - 22
    while (i >= 0) {
      if (tail[i] == 0x50.toByte() && tail[i + 1] == 0x4b.toByte() && tail[i + 2] == 0x05.toByte() && tail[i + 3] == 0x06.toByte()) {
        eocd = i
        break
      }
      i--
    }
    if (eocd < 0) throw DiscException("this looks like a zip file but its directory is missing: the file is incomplete")
    val entries = u16(tail, eocd + 10)
    val cdSize = u32(tail, eocd + 12)
    val cdAt = u32(tail, eocd + 16)
    if (entries == 0) throw DiscException("the zip archive is empty")
    if (cdAt + cdSize > source.size) throw DiscException("the zip archive is incomplete: its directory points past the end of the file")
    val cd = source.read(cdAt, cdSize.toInt())

    // The base directory that holds the game: everything before `Game/`, when there is one.
    var p = 0

    var written = 0
    var bytes = 0L
    var skipped = 0
    p = 0
    while (p + 46 <= cd.size) {
      if (u32(cd, p) != 0x02014b50L) break
      val method = u16(cd, p + 10)
      val compressedSize = u32(cd, p + 20)
      val nameLen = u16(cd, p + 28)
      val extraLen = u16(cd, p + 30)
      val commentLen = u16(cd, p + 32)
      val localAt = u32(cd, p + 42)
      val rawName = String(cd, p + 46, nameLen, Charsets.UTF_8)
      p += 46 + nameLen + extraLen + commentLen

      val name = normalise(rawName, "")
      if (name == null || isJunk(name)) {
        skipped++
        continue
      }
      // A directory entry: nothing to write, and (see below) nothing to make first.
      if (rawName.replace('\\', '/').endsWith("/")) {
        skipped++
        continue
      }
      if (localAt + 30 > source.size) throw DiscException("the zip archive is incomplete: an entry points past the end of the file")
      val local = source.read(localAt, 30)
      val localNameLen = u16(local, 26)
      val localExtraLen = u16(local, 28)
      val dataAt = localAt + 30 + localNameLen + localExtraLen
      if (dataAt + compressedSize > source.size) {
        throw DiscException(
          "the zip archive is incomplete: \"$rawName\" is not fully in the file. Copy the archive again, completely",
        )
      }
      val data = when (method) {
        0 -> source.read(dataAt, compressedSize.toInt())
        8 -> inflate(source.read(dataAt, compressedSize.toInt()), rawName)
        else -> throw DiscException("\"$rawName\" is compressed with method $method, which is not supported (use a normal zip)")
      }
      // Done per entry, not from a directory entry, because many zips list files only and never the folder.
      val target = stripToGame(name)
      sink.writeFile(target, data)
      written++
      bytes += data.size
      onProgress(written, written + skipped, target)
    }
    if (written == 0) throw DiscException("the archive contains no files")
    return Result(written, bytes, skipped, "zip")
  }

  /**
   * Method 8 is *raw* deflate: the deflate stream, with no zlib header (APPNOTE 4.4.5). `Inflater(true)`
   * says "nowrap"; the default would expect the zlib wrapper and fail with "incorrect header check" on
   * archives written by Info-ZIP, Python's zipfile and most other tools.
   */
  private fun inflate(data: ByteArray, name: String): ByteArray = try {
    java.util.zip.InflaterInputStream(java.io.ByteArrayInputStream(data), java.util.zip.Inflater(true))
      .use { it.readBytes() }
  } catch (e: Exception) {
    throw DiscException("\"$name\" is damaged inside the archive (${e.message})", e)
  }

  // ---- tar -----------------------------------------------------------------------------------------

  private fun untar(
    data: ByteSource,
    gzip: Boolean,
    sink: FileSink,
    onProgress: (Int, Int, String) -> Unit,
  ): Result {
    var at = 0L
    var longName: String? = null
    var written = 0
    var bytes = 0L
    var skipped = 0
    if (data.size < 512) throw DiscException("the archive is too short to be a tar file: the copy is incomplete")
    while (at + 512 <= data.size) {
      val h = data.read(at, 512)
      if (h.all { it.toInt() == 0 }) break // end of archive: two zero blocks
      val name = cstr(h, 0, 100)
      val size = octal(h, 124, 12)
      val type = h[156].toInt().toChar()
      val prefix = cstr(h, 345, 155)
      val dataAt = at + 512
      // Extended names (`././@LongLink`) and pax headers: only the name matters here.
      if (type == 'L') {
        longName = String(data.read(dataAt, size.toInt()), Charsets.UTF_8).trimEnd('\u0000')
        at = dataAt + ((size + 511) / 512) * 512
        continue
      }
      if (type == 'x') {
        at = dataAt + ((size + 511) / 512) * 512
        continue
      }
      val full = longName ?: if (prefix.isEmpty()) name else "$prefix/$name"
      longName = null
      var entry = normalise(full, "")
      val isFile = type == '0' || type == '\u0000' || type == '7'
      if (entry != null) entry = stripToGame(entry)
      if (!isFile || entry == null || isJunk(entry)) {
        skipped++
        at = dataAt + ((size + 511) / 512) * 512
        continue
      }
      if (dataAt + size > data.size) {
        throw DiscException("the tar archive is incomplete: \"$full\" is not fully in the file. Copy the archive again, completely")
      }
      sink.writeFile(entry, data.read(dataAt, size.toInt()))
      written++
      bytes += size
      onProgress(written, written + skipped, entry)
      at = dataAt + ((size + 511) / 512) * 512
    }
    if (written == 0) throw DiscException("the archive contains no files")
    return Result(written, bytes, skipped, if (gzip) "tar.gz" else "tar")
  }

  private fun cstr(b: ByteArray, at: Int, max: Int): String {
    var end = at
    val limit = minOf(at + max, b.size)
    while (end < limit && b[end].toInt() != 0) end++
    return String(b, at, end - at, Charsets.UTF_8)
  }

  /** A tar numeric field: octal digits, possibly space/NUL padded (or base-256, which tar calls "large"). */
  private fun octal(b: ByteArray, at: Int, len: Int): Long {
    if (b[at].toInt() and 0x80 != 0) {
      var v = 0L
      for (i in at until at + len) v = (v shl 8) or (b[i].toLong() and 0xff)
      return v and 0x7fffffffffffffffL
    }
    var v = 0L
    for (i in at until at + len) {
      val c = b[i].toInt()
      if (c < 0x30 || c > 0x37) continue
      v = v * 8 + (c - 0x30)
    }
    return v
  }

  private fun u16(b: ByteArray, o: Int): Int = (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8)

  private fun u32(b: ByteArray, o: Int): Long =
    (b[o].toLong() and 0xff) or ((b[o + 1].toLong() and 0xff) shl 8) or
      ((b[o + 2].toLong() and 0xff) shl 16) or ((b[o + 3].toLong() and 0xff) shl 24)

  /** Kept for callers that stream out of an archive without a sink. */
  fun copyTo(output: OutputStream, data: ByteArray) = output.write(data)
}

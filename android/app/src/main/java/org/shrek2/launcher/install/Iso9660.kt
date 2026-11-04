package org.shrek2.launcher.install

/**
 * Minimal ISO 9660 reader with Joliet support (read-only, single-extent files).
 *
 * A line-for-line port of `installer/src/iso9660.ts`, the parser the web build installs from: a disc
 * image the desktop tool accepts must be accepted here, with identical file offsets.
 */
class IsoImage(private val src: ByteSource) {

  val volumeId: String
  val joliet: Boolean
  private val root: IsoEntry
  private val dirCache = HashMap<Long, List<IsoEntry>>()

  class IsoEntry(
    val name: String,
    val isDir: Boolean,
    /** Byte offset of the file data within the image. */
    val offset: Long,
    val size: Long,
  )

  init {
    var pvd: ByteArray? = null
    var svd: ByteArray? = null
    var sector = 16
    while (sector < 64) {
      val vd = src.read(sector * SECTOR.toLong(), SECTOR)
      if (Bytes.latin1(vd, 1, 6) != "CD001") throw IllegalArgumentException("not an ISO 9660 image (sector $sector)")
      val type = vd[0].toInt() and 0xff
      if (type == 255) break
      if (type == 1 && pvd == null) pvd = vd
      // Joliet: supplementary descriptor with a UCS-2 escape sequence (%/@, %/C or %/E).
      if (type == 2 && vd[88].toInt() and 0xff == 0x25 && vd[89].toInt() and 0xff == 0x2f &&
        (vd[90].toInt() and 0xff) in JOLIET_ESCAPES
      ) {
        svd = vd
      }
      sector++
    }
    if (pvd == null) throw IllegalArgumentException("ISO 9660 primary volume descriptor not found")
    volumeId = Bytes.latin1(pvd, 40, 72).trim()
    joliet = svd != null
    root = parseRecord(svd ?: pvd, 156) ?: throw IllegalArgumentException("ISO 9660 root directory record is missing")
  }

  /** List a directory by slash-separated path ("" = root). Case-insensitive. */
  fun list(path: String = ""): List<IsoEntry> {
    val dir = if (path.isEmpty()) root else lookup(path)
    if (dir == null || !dir.isDir) throw IllegalArgumentException("not a directory: $path")
    return readDir(dir)
  }

  /** Find an entry by slash-separated path, case-insensitively. */
  fun lookup(path: String): IsoEntry? {
    var cur: IsoEntry = root
    for (part in path.split(Regex("[\\\\/]+")).filter { it.isNotEmpty() }) {
      if (!cur.isDir) return null
      val want = part.lowercase()
      cur = readDir(cur).firstOrNull { it.name.lowercase() == want } ?: return null
    }
    return cur
  }

  fun open(path: String): ByteSource {
    val e = lookup(path)
    if (e == null || e.isDir) throw NoSuchElementException("file not found in ISO: $path")
    return SliceSource(src, e.offset, e.size)
  }

  /** Depth-first walk of every file: (path, entry). */
  fun walk(path: String = "", dir: IsoEntry = root, out: MutableList<Pair<String, IsoEntry>> = ArrayList()): List<Pair<String, IsoEntry>> {
    for (e in readDir(dir)) {
      val p = if (path.isEmpty()) e.name else "$path/${e.name}"
      if (e.isDir) walk(p, e, out) else out += p to e
    }
    return out
  }

  private fun readDir(dir: IsoEntry): List<IsoEntry> {
    dirCache[dir.offset]?.let { return it }
    val data = src.read(dir.offset, dir.size.toInt())
    val out = ArrayList<IsoEntry>()
    var o = 0
    while (o < data.size) {
      val len = data[o].toInt() and 0xff
      if (len == 0) {
        // Records never straddle sectors; zero padding means "continue at next sector".
        o = (o / SECTOR + 1) * SECTOR
        continue
      }
      parseRecord(data, o)?.let { out += it }
      o += len
    }
    dirCache[dir.offset] = out
    return out
  }

  private fun parseRecord(b: ByteArray, o: Int): IsoEntry? {
    val extent = Bytes.u32(b, o + 2)
    val size = Bytes.u32(b, o + 10)
    val flags = b[o + 25].toInt() and 0xff
    val nameLen = b[o + 32].toInt() and 0xff
    val nameStart = o + 33
    // "\0" and "\1" are the self/parent entries.
    if (nameLen == 1 && (b[nameStart].toInt() == 0 || b[nameStart].toInt() == 1)) {
      return if (o == 156) IsoEntry("", true, extent * SECTOR, size) else null
    }
    var name: String
    if (joliet) {
      val sb = StringBuilder()
      var i = 0
      while (i + 1 < nameLen) {
        sb.append(((((b[nameStart + i].toInt() and 0xff) shl 8) or (b[nameStart + i + 1].toInt() and 0xff))).toChar())
        i += 2
      }
      name = sb.toString()
    } else {
      name = Bytes.latin1(b, nameStart, nameStart + nameLen)
    }
    name = name.replace(Regex(";\\d+$"), "")
    if (flags and 2 == 0 && name.endsWith(".")) name = name.dropLast(1)
    if (flags and 0x80 != 0) throw IllegalStateException("multi-extent ISO files are not supported: $name")
    return IsoEntry(name, flags and 2 != 0, extent * SECTOR, size)
  }

  companion object {
    const val SECTOR = 2048
    private val JOLIET_ESCAPES = intArrayOf(0x40, 0x43, 0x45)
  }
}

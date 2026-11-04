package org.shrek2.launcher.install

import org.shrek2.launcher.DiscException
import org.shrek2.launcher.InstallException
import org.shrek2.launcher.MemberException

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
    // An ISO is written in whole 2048-byte sectors, so a file that is not a multiple of one was cut off
    // somewhere: the tail of the last sector is simply missing. This is checked before anything is parsed,
    // because a short tail can leave every structure readable and only the very last file damaged.
    val partial = src.size % SECTOR
    if (partial != 0L) {
      val sectors = src.size / SECTOR
      throw DiscException(
        "the disc image is ${src.size} bytes, which is not a whole number of 2048-byte sectors: it is " +
          "${SECTOR - partial} bytes short of $sectors sectors (${(sectors + 1) * SECTOR} bytes). The image " +
          "is incomplete -- copy it again from the disc, completely",
      )
    }
    // A volume descriptor table that does not even fit is the signature of a cut-off image (an ISO is
    // written in 2048-byte sectors, so a good one is always a whole number of sectors).
    if (src.size < 17L * SECTOR) {
      throw DiscException(
        "the image is only ${src.size} bytes: it stops before its own volume descriptors, so the copy is " +
          "incomplete. Copy the disc image again, completely, and retry",
      )
    }
    var pvd: ByteArray? = null
    var svd: ByteArray? = null
    var sector = 16
    while (sector < 64) {
      val vd = try {
        src.read(sector * SECTOR.toLong(), SECTOR)
      } catch (e: DiscException) {
        // Running out of image inside the descriptor table: either the table is shorter than an ISO's
        // always is, or the file was cut short. Both mean "copy it again".
        throw DiscException("the image ends before its volume descriptors do -- the copy is incomplete", e)
      }
      if (Bytes.latin1(vd, 1, 6) != "CD001") {
        throw DiscException(
          "not an ISO 9660 disc image: sector $sector does not start with CD001. Pick the .iso file of the " +
            "disc itself, not a .bin/.cue pair or a mounted folder",
        )
      }
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
    if (pvd == null) throw DiscException("the image has no ISO 9660 primary volume descriptor")
    volumeId = Bytes.latin1(pvd, 40, 72).trim()
    // The volume descriptor states how long the disc is (in logical blocks). A file shorter than that is
    // a partial copy even when it happens to end on a sector boundary.
    val declared = Bytes.u32(pvd, 80) * SECTOR
    if (declared > 0 && declared > src.size) {
      throw DiscException(
        "the disc image is ${src.size} bytes, but its own volume descriptor says the disc is " +
          "${declared / SECTOR} sectors long (${declared} bytes): ${declared - src.size} bytes are missing " +
          "from the end. The image is incomplete -- copy it again from the disc, completely",
      )
    }
    joliet = svd != null
    root = parseRecord(svd ?: pvd, 156)
      ?: throw DiscException("the image has no root directory record (its volume descriptor is damaged)")
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
    if (e == null || e.isDir) throw MemberException(path, "is not on the disc image")
    // The directory says where the file is; the image has to be long enough to contain it. Checking here
    // turns "read [x, +y) outside source" into the name of the file that is missing from the copy.
    if (e.offset + e.size > src.size) {
      throw MemberException(
        path,
        "is missing from the image: the disc places it at byte ${e.offset} and it is ${e.size} bytes long, " +
          "but the image ends at ${src.size}. The copy of the disc image is incomplete; copy it again",
      )
    }
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
    val data = try {
      src.read(dir.offset, dir.size.toInt())
    } catch (e: DiscException) {
      throw DiscException(
        "the disc's directory listing is not in the image: it should be at byte ${dir.offset}, but the file " +
          "ends at ${src.size}. The copy of the disc image is incomplete",
        e,
      )
    }
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
    if (flags and 0x80 != 0) throw DiscException("this disc stores \"$name\" in several pieces, which is not supported")
    return IsoEntry(name, flags and 2 != 0, extent * SECTOR, size)
  }

  companion object {
    const val SECTOR = 2048
    private val JOLIET_ESCAPES = intArrayOf(0x40, 0x43, 0x45)
  }
}

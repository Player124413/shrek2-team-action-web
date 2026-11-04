package org.shrek2.launcher.install

import java.io.IOException
import java.nio.charset.Charset

/**
 * Windows Installer (MSI) database reader: string pool, schema-driven tables, and the
 * File/Component/Directory/Media views the installer needs — a port of `installer/src/msi.ts`.
 */
class MsiDatabase(bytes: ByteArray) {

  /** One cell of a row: a string from the pool, an integer, or nothing. */
  sealed class Cell {
    data class Str(val value: String) : Cell()
    data class Num(val value: Long) : Cell()
    object Null : Cell()
  }

  class Row(private val cols: List<String>, private val cells: Array<Cell>) {
    fun cell(name: String): Cell {
      val i = cols.indexOf(name)
      return if (i < 0) Cell.Null else cells[i]
    }

    fun str(name: String): String? = (cell(name) as? Cell.Str)?.value

    fun num(name: String): Long? = (cell(name) as? Cell.Num)?.value
  }

  class Column(val name: String, val type: Int)

  val codepage: Int
  private val cfb: CompoundFile
  private val streams = HashMap<String, CompoundFile.Entry>()
  private val strings: List<String?>
  private val strRefSize: Int
  private val schema = LinkedHashMap<String, List<Column>>()
  private val decoder: Charset

  init {
    cfb = CompoundFile(bytes)
    for (e in cfb.streams()) streams[decodeStreamName(e.name)] = e
    val pool = stream("!_StringPool")
    val data = stream("!_StringData")
    fun w(i: Int): Int = Bytes.u16(pool, i * 2)
    codepage = w(0) or ((w(1) and 0x7fff) shl 16)
    strRefSize = if (w(1) and 0x8000 != 0) 3 else 2
    decoder = if (codepage == 65001) Charsets.UTF_8 else Cp1252
    val count = pool.size / 4
    val list = ArrayList<String?>()
    list += null
    var off = 0
    var i = 1
    while (i < count) {
      var len = w(i * 2)
      val refs = w(i * 2 + 1)
      if (len == 0 && refs == 0) {
        list += ""
        i++
        continue
      }
      if (len == 0) {
        // Long string: the length's high word follows in the next pool entry.
        len = (w(i * 2 + 3) shl 16) + w(i * 2 + 2)
        i += 2
      } else {
        i += 1
      }
      val end = minOf(off + len, data.size)
      list += String(data, minOf(off, data.size), maxOf(0, end - off), decoder)
      off += len
    }
    strings = list

    // The schema is the _Columns table itself, read before any other table can be.
    val sparse = LinkedHashMap<String, MutableList<Column?>>()
    for (r in readTable(
      "_Columns",
      listOf(
        Column("Table", MSITYPE_STRING),
        Column("Number", 0x0102),
        Column("Name", MSITYPE_STRING),
        Column("Type", 0x0102),
      ),
    )) {
      val t = r.str("Table") ?: continue
      val number = (r.num("Number") ?: 0L).toInt()
      if (number < 1) continue
      val cols = sparse.getOrPut(t) { ArrayList() }
      while (cols.size < number) cols += null
      cols[number - 1] = Column(r.str("Name") ?: "", (r.num("Type") ?: 0L).toInt())
    }
    for ((t, cols) in sparse) schema[t] = cols.filterNotNull()
  }

  fun tables(): List<String> = schema.keys.sorted()

  fun table(name: String): List<Row> {
    val cols = schema[name] ?: throw IllegalArgumentException("MSI table not found: $name")
    if (!streams.containsKey("!$name")) return emptyList() // declared but empty
    return readTable(name, cols)
  }

  fun stream(decodedName: String): ByteArray {
    val e = streams[decodedName] ?: throw IOException("MSI stream not found: $decodedName")
    return cfb.read(e)
  }

  private fun readTable(name: String, cols: List<Column>): List<Row> {
    val raw = stream("!$name")
    val widths = cols.map {
      if (it.type and MSITYPE_STRING != 0) strRefSize else if (it.type and 0xff <= 2) 2 else 4
    }
    val rowSize = widths.sum()
    if (rowSize == 0) return emptyList()
    val n = raw.size / rowSize
    val cells = Array(n) { arrayOfNulls<Cell>(cols.size) }
    val names = cols.map { it.name }
    var o = 0
    for (ci in cols.indices) {
      val width = widths[ci]
      val type = cols[ci].type
      for (r in 0 until n) {
        var v = 0L
        for (k in width - 1 downTo 0) {
          val idx = o + r * width + k
          v = v * 256 + (if (idx < raw.size) raw[idx].toLong() and 0xff else 0L)
        }
        val cell: Cell = when {
          type and MSITYPE_STRING != 0 -> {
            val s = if (v in 1 until strings.size.toLong()) strings[v.toInt()] else null
            if (s == null) Cell.Null else Cell.Str(s)
          }
          v == 0L -> Cell.Null
          else -> Cell.Num(if (width == 2) v - 0x8000 else v - 0x80000000L)
        }
        cells[r][ci] = cell
      }
      o += width * n
    }
    return (0 until n).map { r -> Row(names, Array(cols.size) { c -> cells[r][c] ?: Cell.Null }) }
  }

  companion object {
    private const val MSITYPE_STRING = 0x0800

    val Cp1252: Charset = runCatching { Charset.forName("windows-1252") }.getOrDefault(Charsets.ISO_8859_1)

    /** MSI encodes stream names into code points 0x3800..0x4840 (two base-64 characters each). */
    fun decodeStreamName(name: String): String {
      fun mime(x: Int): Char = when {
        x < 10 -> (48 + x).toChar()
        x < 36 -> (55 + x).toChar()
        x < 62 -> (61 + x).toChar()
        x == 62 -> '.'
        else -> '_'
      }
      val out = StringBuilder()
      var i = 0
      while (i < name.length) {
        val ch = name[i]
        var c = ch.code
        if (c in 0x3800 until 0x4840) {
          if (c >= 0x4800) {
            out.append(mime(c - 0x4800))
          } else {
            c -= 0x3800
            out.append(mime(c and 0x3f)).append(mime((c shr 6) and 0x3f))
          }
        } else if (c == 0x4840) {
          out.append('!')
        } else {
          out.append(ch)
        }
        i++
      }
      return out.toString()
    }
  }
}

/** A file of the install, with its destination resolved from the MSI's Directory table. */
class MsiFile(
  val key: String,
  /** Install path relative to INSTALLDIR (forward slashes), or null when outside it. */
  val installPath: String?,
  /** Path relative to the media root, for uncompressed files. */
  val sourcePath: String,
  val size: Long,
  val sequence: Long,
  val compressed: Boolean,
  /** MD5 from MsiFileHash (16 bytes) when present. */
  val md5: ByteArray?,
)

class MsiMedia(val diskId: Long, val lastSequence: Long, val cabinet: String?, val volumeLabel: String?)

class MsiRegistryValue(val root: Long, val key: String?, val name: String?, val value: String?)

class MsiLayout(
  val productName: String,
  val files: List<MsiFile>,
  val media: List<MsiMedia>,
  val registry: List<MsiRegistryValue>,
)

/** Resolve the install layout of every file, relative to INSTALLDIR (`readLayout` in the TS tool). */
fun readLayout(db: MsiDatabase): MsiLayout {
  val dirs = HashMap<String, MsiDatabase.Row>()
  for (r in db.table("Directory")) {
    r.str("Directory")?.let { dirs[it] = r }
  }
  fun longName(s: String): String = if (s.contains("|")) s.split("|")[1] else s
  fun split(defaultDir: String): Pair<String, String> {
    val parts = defaultDir.split(":")
    val target = parts[0]
    val source = if (parts.size > 1) parts[1] else target
    return longName(target) to longName(source)
  }

  class Res(val inst: List<String>?, val src: List<String>)
  val memo = HashMap<String, Res>()
  fun resolve(id: String): Res {
    memo[id]?.let { return it }
    val r = dirs[id] ?: throw IllegalArgumentException("unknown MSI directory $id")
    val (target, source) = split(r.str("DefaultDir") ?: "")
    val parent = r.str("Directory_Parent")
    val res = if (parent == null || parent == id) {
      // TARGETDIR (SourceDir) is the media root.
      Res(null, emptyList())
    } else {
      val p = resolve(parent)
      val inst = if (id == "INSTALLDIR") {
        emptyList()
      } else if (p.inst == null) {
        null
      } else if (target == ".") {
        p.inst
      } else {
        p.inst + target
      }
      Res(inst, if (source == ".") p.src else p.src + source)
    }
    memo[id] = res
    return res
  }

  val comps = HashMap<String, MsiDatabase.Row>()
  for (r in db.table("Component")) {
    r.str("Component")?.let { comps[it] = r }
  }
  val hashes = HashMap<String, ByteArray>()
  for (r in db.table("MsiFileHash")) {
    val md5 = ByteArray(16)
    val parts = listOf("HashPart1", "HashPart2", "HashPart3", "HashPart4")
    for ((i, n) in parts.withIndex()) {
      val v = (r.num(n) ?: 0L).toInt()
      md5[i * 4] = v.toByte()
      md5[i * 4 + 1] = (v ushr 8).toByte()
      md5[i * 4 + 2] = (v ushr 16).toByte()
      md5[i * 4 + 3] = (v ushr 24).toByte()
    }
    r.str("File_")?.let { hashes[it] = md5 }
  }

  val files = db.table("File").map { f ->
    val key = f.str("File") ?: ""
    val comp = comps[f.str("Component_") ?: ""] ?: throw IllegalArgumentException("file $key references unknown component")
    val d = resolve(comp.str("Directory_") ?: "")
    val name = longName(f.str("FileName") ?: "")
    val attrs = f.num("Attributes") ?: 0L
    MsiFile(
      key = key,
      installPath = d.inst?.let { (it + name).joinToString("/") },
      sourcePath = (d.src + name).joinToString("/"),
      size = f.num("FileSize") ?: 0L,
      sequence = f.num("Sequence") ?: 0L,
      compressed = attrs and 0x2000L == 0L, // msidbFileAttributesNoncompressed
      md5 = hashes[key],
    )
  }
  val props = HashMap<String, String?>()
  for (r in db.table("Property")) {
    r.str("Property")?.let { props[it] = r.str("Value") }
  }
  return MsiLayout(
    productName = props["ProductName"] ?: "",
    files = files,
    media = db.table("Media").map {
      MsiMedia(it.num("DiskId") ?: 0L, it.num("LastSequence") ?: 0L, it.str("Cabinet"), it.str("VolumeLabel"))
    },
    registry = db.table("Registry").map { MsiRegistryValue(it.num("Root") ?: 0L, it.str("Key"), it.str("Name"), it.str("Value")) },
  )
}

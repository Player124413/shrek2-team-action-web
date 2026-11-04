package org.shrek2.launcher.install

import java.io.IOException

/**
 * OLE Compound File Binary (CFB / "structured storage") reader, enough for MSI databases — a port of
 * `installer/src/cfb.ts`. MSI files are small, so the whole file is held in memory.
 */
class CompoundFile(bytes: ByteArray) {

  class Entry(
    /** Raw UTF-16 name (MSI stream names use private-use code points; see `Msi.decodeStreamName`). */
    val name: String,
    val type: Int, // 1 storage, 2 stream, 5 root
    val start: Long,
    val size: Long,
  )

  val entries = ArrayList<Entry>()

  private val b = bytes
  private val sectorSize: Int
  private val miniSectorSize: Int
  private val miniCutoff: Long
  private val fat: LongArray
  private val miniFat: LongArray
  private val miniStream: ByteArray

  init {
    if (bytes.size < 512) throw IOException("not an OLE compound file (too short)")
    val sig = byteArrayOf(0xd0.toByte(), 0xcf.toByte(), 0x11, 0xe0.toByte(), 0xa1.toByte(), 0xb1.toByte(), 0x1a, 0xe1.toByte())
    for (i in sig.indices) if (b[i] != sig[i]) throw IOException("not an OLE compound file")
    if (Bytes.u16(b, 0x1c) != 0xfffe) throw IOException("unexpected CFB byte order mark")
    sectorSize = 1 shl Bytes.u16(b, 0x1e)
    miniSectorSize = 1 shl Bytes.u16(b, 0x20)
    val numFatSectors = Bytes.u32(b, 0x2c)
    val firstDirSector = Bytes.u32(b, 0x30)
    miniCutoff = Bytes.u32(b, 0x38)
    val firstMiniFat = Bytes.u32(b, 0x3c)
    var difatSector = Bytes.u32(b, 0x44)
    val numDifat = Bytes.u32(b, 0x48)

    // Collect FAT sector locations from the header DIFAT and the DIFAT chain.
    val fatSectors = ArrayList<Long>()
    var i = 0
    while (i < 109 && fatSectors.size < numFatSectors) {
      fatSectors += Bytes.u32(b, 0x4c + i * 4)
      i++
    }
    var n = 0L
    while (n < numDifat && difatSector != ENDOFCHAIN && difatSector != FREESECT) {
      val base = sectorOffset(difatSector)
      val per = sectorSize / 4 - 1
      var k = 0
      while (k < per && fatSectors.size < numFatSectors) {
        fatSectors += Bytes.u32(b, base + k * 4)
        k++
      }
      difatSector = Bytes.u32(b, base + per * 4)
      n++
    }
    val per = sectorSize / 4
    fat = LongArray(fatSectors.size * per)
    for (k in fatSectors.indices) {
      val base = sectorOffset(fatSectors[k])
      for (j in 0 until per) fat[k * per + j] = Bytes.u32(b, base + j * 4)
    }

    // Directory entries.
    val dir = readChain(firstDirSector, fat, sectorSize, b) { sectorOffset(it).toLong() }
    var o = 0
    while (o + 128 <= dir.size) {
      val nameLen = Bytes.u16(dir, o + 0x40)
      val name = StringBuilder()
      var k = 0
      while (k + 2 < nameLen) {
        name.append(Bytes.u16(dir, o + k).toChar())
        k += 2
      }
      entries += Entry(
        name = name.toString(),
        type = dir[o + 0x42].toInt() and 0xff,
        start = Bytes.u32(dir, o + 0x74),
        size = Bytes.u32(dir, o + 0x78), // v3 files: the high dword is undefined/zero
      )
      o += 128
    }
    val root = entries.firstOrNull() ?: throw IOException("CFB root entry missing")
    if (root.type != 5) throw IOException("CFB root entry missing")

    val miniFatBytes = if (firstMiniFat == ENDOFCHAIN) ByteArray(0)
    else readChain(firstMiniFat, fat, sectorSize, b) { sectorOffset(it).toLong() }
    miniFat = LongArray(miniFatBytes.size / 4)
    for (k in miniFat.indices) miniFat[k] = Bytes.u32(miniFatBytes, k * 4)
    miniStream = if (root.start == ENDOFCHAIN) {
      ByteArray(0)
    } else {
      val ms = readChain(root.start, fat, sectorSize, b) { sectorOffset(it).toLong() }
      ms.copyOfRange(0, minOf(ms.size.toLong(), root.size).toInt())
    }
  }

  /** All stream entries directly or indirectly under the root (an MSI file is flat). */
  fun streams(): List<Entry> = entries.filter { it.type == 2 }

  fun read(entry: Entry): ByteArray {
    // Small streams ("mini streams") live inside the root entry's own stream, addressed in 64-byte
    // units: the chain and the storage are both different from the regular sector case.
    if (entry.size < miniCutoff) {
      val data = readChain(entry.start, miniFat, miniSectorSize, miniStream) { it * miniSectorSize }
      return data.copyOfRange(0, minOf(data.size.toLong(), entry.size).toInt())
    }
    val data = readChain(entry.start, fat, sectorSize, b) { sectorOffset(it).toLong() }
    return data.copyOfRange(0, minOf(data.size.toLong(), entry.size).toInt())
  }

  private fun sectorOffset(sector: Long): Int {
    val off = (sector + 1) * sectorSize
    checkRange(off, sectorSize.toLong(), b.size.toLong())
    return off.toInt()
  }

  private fun readChain(start: Long, fat: LongArray, size: Int, store: ByteArray, offsetOf: (Long) -> Long): ByteArray {
    val chunks = ArrayList<ByteArray>()
    var s = start
    var guard = 0
    while (s != ENDOFCHAIN) {
      if (s == FREESECT || s >= fat.size || guard++ > fat.size) throw IOException("corrupt CFB chain at sector $s")
      val o = offsetOf(s)
      checkRange(o, size.toLong(), store.size.toLong())
      chunks += store.copyOfRange(o.toInt(), (o + size).toInt())
      s = fat[s.toInt()]
    }
    val out = ByteArray(chunks.size * size)
    for ((k, c) in chunks.withIndex()) System.arraycopy(c, 0, out, k * size, size)
    return out
  }

  private companion object {
    const val ENDOFCHAIN = 0xFFFFFFFEL
    const val FREESECT = 0xFFFFFFFFL
  }
}

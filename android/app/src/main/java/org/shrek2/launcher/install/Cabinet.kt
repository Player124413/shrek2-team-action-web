package org.shrek2.launcher.install

import org.shrek2.launcher.DiscException
import org.shrek2.launcher.InstallException
import org.shrek2.launcher.MemberException

import java.io.IOException

/**
 * Microsoft Cabinet (.cab) reader. Supports uncompressed and LZX folders (MSZIP and Quantum are
 * rejected with a clear error; this game's cabinet is LZX with a 2 MiB window).
 *
 * A port of `installer/src/cab.ts`.
 */
class Cabinet(private val src: ByteSource) {

  class CabFolder(
    val index: Int,
    val dataOffset: Long,
    val dataBlocks: Int,
    /** Low nibble: 0 none, 1 MSZIP, 2 Quantum, 3 LZX. */
    val compression: Int,
    val windowBits: Int,
  )

  class CabFile(val name: String, val size: Long, val folder: Int, val offsetInFolder: Long)

  val folders = ArrayList<CabFolder>()
  val files = ArrayList<CabFile>()
  private val dataReserve: Int

  init {
    val h = src.read(0, minOf(src.size, 64L * 1024).toInt())
    if (h.size < 36 || h[0].toInt() != 0x4d || h[1].toInt() != 0x53 || h[2].toInt() != 0x43 || h[3].toInt() != 0x46) {
      throw IOException("is not a cabinet file: it does not start with MSCF (${h.size} bytes readable)")
    }
    val coffFiles = Bytes.u32(h, 16)
    val nFolders = Bytes.u16(h, 26)
    val nFiles = Bytes.u16(h, 28)
    val flags = Bytes.u16(h, 30)
    var o = 36
    var folderReserve = 0
    var reserve = 0
    if (flags and 4 != 0) {
      val headerReserve = Bytes.u16(h, o)
      folderReserve = h[o + 2].toInt() and 0xff
      reserve = h[o + 3].toInt() and 0xff
      o += 4 + headerReserve
    }
    dataReserve = reserve
    if (flags and 1 != 0) o = skipStrings(h, o, 2)
    if (flags and 2 != 0) o = skipStrings(h, o, 2)
    for (i in 0 until nFolders) {
      val type = Bytes.u16(h, o + 6)
      folders += CabFolder(
        index = i,
        dataOffset = Bytes.u32(h, o),
        dataBlocks = Bytes.u16(h, o + 4),
        compression = type and 0xf,
        windowBits = (type shr 8) and 0x1f,
      )
      o += 8 + folderReserve
    }
    val fileTableLen = minOf(src.size - coffFiles, nFiles * 300L + 4096).toInt()
    val fileTable = src.read(coffFiles, maxOf(0, fileTableLen))
    var p = 0
    for (i in 0 until nFiles) {
      if (p + 16 > fileTable.size) break
      val folder = Bytes.u16(fileTable, p + 8)
      if (folder >= 0xfffd) throw IOException("cabinet sets spanning multiple files are not supported")
      val name = Bytes.cstr(fileTable, p + 16, 1024)
      files += CabFile(name, Bytes.u32(fileTable, p), folder, Bytes.u32(fileTable, p + 4))
      p += 16 + name.length + 1 // latin-1: one char per byte, plus the NUL
    }
  }

  /** Decompress an entire folder into one buffer. */
  fun extractFolder(index: Int): ByteArray = try {
    extractFolderAt(index)
  } catch (e: DiscException) {
    // Every block's header says how long the block is; if the image ends before it does, the copy of the
    // disc is short rather than the cabinet being broken -- and [e] already says exactly that.
    throw e
  }

  private fun extractFolderAt(index: Int): ByteArray {
    val f = folders[index]
    val blocks = ArrayList<LongArray>() // offset, cb, uncompressed size
    var o = f.dataOffset
    var total = 0L
    for (i in 0 until f.dataBlocks) {
      val hdr = src.read(o, 8)
      val cb = Bytes.u16(hdr, 4)
      val uncomp = Bytes.u16(hdr, 6)
      blocks += longArrayOf(o + 8 + dataReserve, cb.toLong(), uncomp.toLong())
      total += uncomp
      o += 8L + dataReserve + cb
    }
    val out = ByteArray(total.toInt())
    var w = 0
    when (f.compression) {
      0 -> for (b in blocks) {
        val data = src.read(b[0], b[1].toInt())
        System.arraycopy(data, 0, out, w, data.size)
        w += data.size
      }
      3 -> {
        val lzx = LzxDecoder(f.windowBits)
        for (b in blocks) {
          val frame = lzx.decodeFrame(src.read(b[0], b[1].toInt()), b[2].toInt())
          System.arraycopy(frame, 0, out, w, frame.size)
          w += frame.size
        }
      }
      else -> throw IOException("cabinet folder $index: unsupported compression type ${f.compression}")
    }
    return out
  }

  private fun skipStrings(b: ByteArray, from: Int, n: Int): Int {
    var o = from
    for (i in 0 until n) {
      while (o < b.size && b[o].toInt() != 0) o++
      o++
    }
    return o
  }
}

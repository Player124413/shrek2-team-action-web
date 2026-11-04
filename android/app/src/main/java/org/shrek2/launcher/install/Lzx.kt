package org.shrek2.launcher.install

/**
 * LZX decompressor for the Microsoft Cabinet variant (one instance per CAB folder).
 *
 * A port of `installer/src/lzx.ts`. Each CFDATA block carries one 32 KiB output frame whose compressed
 * bits start on a fresh 16-bit boundary; Huffman tree lengths, repeated offsets and the sliding window
 * persist across frames. The TypeScript original is verified byte-for-byte against `cabextract`
 * (`tests/installer/conformance`); this port is checked against the same reference content by
 * `tools/installer-test.sh`.
 */
class LzxDecoder(windowBits: Int) {

  private val mainTree: Huffman
  private val lengthTree = Huffman(LENGTH_NUM, 12)
  private val alignedTree = Huffman(ALIGNED_NUM, 7)
  private val preTree = Huffman(PRETREE_NUM, 6)
  private val br = BitReader()
  private val windowSize: Int
  private val window: ByteArray
  private var windowPos = 0
  private var r0 = 1
  private var r1 = 1
  private var r2 = 1
  private var headerRead = false
  private var intelFileSize = 0
  private var intelStarted = false
  private var intelCurPos = 0
  private var frameCount = 0
  private var blockType = 0
  private var blockLength = 0
  private var blockRemaining = 0

  init {
    val slots = POSITION_SLOTS[windowBits]
    if (slots == null) throw IllegalArgumentException("LZX: unsupported window size 2^$windowBits")
    windowSize = 1 shl windowBits
    window = ByteArray(windowSize)
    mainTree = Huffman(NUM_CHARS + slots * 8, 12)
  }

  /** Decode one CFDATA block into `outSize` (<= 32768) bytes. Returns a fresh array. */
  fun decodeFrame(input: ByteArray, outSize: Int): ByteArray {
    require(outSize in 0..32768) { "LZX: frame too large ($outSize)" }
    br.reset(input)
    if (!headerRead) {
      intelFileSize = if (br.readBits(1) != 0) ((br.readBits(16) shl 16) or br.readBits(16)) else 0
      headerRead = true
    }
    if (windowPos == windowSize) windowPos = 0
    val frameStart = windowPos
    if (frameStart + outSize > windowSize) throw IllegalStateException("LZX: frame crosses window end")
    val win = window
    val mask = windowSize - 1
    var pos = windowPos
    var todo = outSize

    while (todo > 0) {
      if (blockRemaining == 0) readBlockHeader()
      var run = minOf(blockRemaining, todo)
      todo -= run
      blockRemaining -= run

      if (blockType == BLOCK_UNCOMPRESSED) {
        while (run > 0) {
          win[pos++] = br.rawByte()
          run--
        }
        continue
      }
      val aligned = blockType == BLOCK_ALIGNED
      while (run > 0) {
        var sym = br.decode(mainTree)
        if (sym < NUM_CHARS) {
          win[pos++] = sym.toByte()
          run--
          continue
        }
        sym -= NUM_CHARS
        var matchLen = sym and 7
        if (matchLen == 7) matchLen += br.decode(lengthTree)
        matchLen += MIN_MATCH
        val slot = sym ushr 3
        var off: Int
        if (slot == 0) {
          off = r0
        } else if (slot == 1) {
          off = r1
          r1 = r0
          r0 = off
        } else if (slot == 2) {
          off = r2
          r2 = r0
          r0 = off
        } else {
          val extra = EXTRA_BITS[slot].toInt()
          off = POSITION_BASE[slot].toInt() - 2
          if (!aligned) {
            off += br.readBits(extra)
          } else if (extra > 3) {
            off += br.readBits(extra - 3) shl 3
            off += br.decode(alignedTree)
          } else if (extra == 3) {
            off += br.decode(alignedTree)
          } else if (extra > 0) {
            off += br.readBits(extra)
          } else {
            off = 1
          }
          r2 = r1
          r1 = r0
          r0 = off
        }
        if (matchLen > run) throw IllegalStateException("LZX: match overruns frame/block")
        var from = (pos - off) and mask
        for (i in 0 until matchLen) {
          win[pos++] = win[from]
          from = (from + 1) and mask
        }
        run -= matchLen
      }
    }

    windowPos = pos
    val out = win.copyOfRange(frameStart, frameStart + outSize)
    if (intelStarted && intelFileSize != 0 && frameCount < 32768 && outSize > 10) undoE8(out)
    intelCurPos += outSize
    frameCount++
    return out
  }

  private fun readBlockHeader() {
    if (blockType == BLOCK_UNCOMPRESSED) {
      if (blockLength and 1 == 1) br.rawByte() // pad to even length
      br.bitbuf = 0
      br.bitsLeft = 0
    }
    blockType = br.readBits(3)
    val hi = br.readBits(16)
    val lo = br.readBits(8)
    blockLength = (hi shl 8) or lo
    blockRemaining = blockLength
    when (blockType) {
      BLOCK_ALIGNED -> {
        for (i in 0 until ALIGNED_NUM) alignedTree.lens[i] = br.readBits(3).toByte()
        alignedTree.build()
        // Aligned blocks continue with the same trees as verbatim ones.
        readVerbatimTrees()
      }
      BLOCK_VERBATIM -> readVerbatimTrees()
      BLOCK_UNCOMPRESSED -> {
        intelStarted = true
        br.alignForRawData()
        val r = ByteArray(12)
        for (i in 0 until 12) r[i] = br.rawByte()
        r0 = Bytes.u32(r, 0).toInt()
        r1 = Bytes.u32(r, 4).toInt()
        r2 = Bytes.u32(r, 8).toInt()
      }
      else -> throw IllegalStateException("LZX: bad block type $blockType")
    }
  }

  private fun readVerbatimTrees() {
    readLengths(mainTree.lens, 0, NUM_CHARS)
    readLengths(mainTree.lens, NUM_CHARS, mainTree.lens.size)
    mainTree.build()
    if (mainTree.lens[0xe8].toInt() != 0) intelStarted = true
    readLengths(lengthTree.lens, 0, LENGTH_NUM)
    lengthTree.build()
  }

  /** Read delta-coded code lengths `lens[first, last)` using a freshly transmitted pretree. */
  private fun readLengths(lens: ByteArray, first: Int, last: Int) {
    for (i in 0 until PRETREE_NUM) preTree.lens[i] = br.readBits(4).toByte()
    preTree.build()
    var x = first
    while (x < last) {
      val z = br.decode(preTree)
      if (z == 17) {
        var n = br.readBits(4) + 4
        if (x + n > last) throw IllegalStateException("LZX: code length run overflows table")
        while (n-- > 0) lens[x++] = 0
      } else if (z == 18) {
        var n = br.readBits(5) + 20
        if (x + n > last) throw IllegalStateException("LZX: code length run overflows table")
        while (n-- > 0) lens[x++] = 0
      } else if (z == 19) {
        var n = br.readBits(1) + 4
        if (x + n > last) throw IllegalStateException("LZX: code length run overflows table")
        var v = lens[x] - br.decode(preTree)
        if (v < 0) v += 17
        while (n-- > 0) lens[x++] = v.toByte()
      } else {
        var v = lens[x] - z
        if (v < 0) v += 17
        lens[x++] = v.toByte()
      }
    }
  }

  /** Reverse the encoder's x86 CALL (E8) absolute-address translation on an output frame. */
  private fun undoE8(b: ByteArray) {
    val size = intelFileSize
    var cur = intelCurPos
    val end = b.size - 10
    var i = 0
    while (i < end) {
      if (b[i++].toInt() and 0xff != 0xe8) {
        cur++
        continue
      }
      val abs = (b[i].toInt() and 0xff) or ((b[i + 1].toInt() and 0xff) shl 8) or
        ((b[i + 2].toInt() and 0xff) shl 16) or ((b[i + 3].toInt() and 0xff) shl 24)
      if (abs >= -cur && abs < size) {
        val rel = if (abs >= 0) abs - cur else abs + size
        b[i] = rel.toByte()
        b[i + 1] = (rel ushr 8).toByte()
        b[i + 2] = (rel ushr 16).toByte()
        b[i + 3] = (rel ushr 24).toByte()
      }
      i += 4
      cur += 5
    }
  }

  /** Canonical Huffman decoding table: direct lookup for short codes, canonical search for long ones. */
  private class Huffman(val lens: ByteArray, val tableBits: Int) {
    constructor(numSymbols: Int, tableBits: Int) : this(ByteArray(numSymbols), tableBits)

    val table = IntArray(1 shl tableBits)
    val count = IntArray(17)
    val first = IntArray(17)
    val offset = IntArray(18)
    val sorted = IntArray(lens.size)
    var empty = true
      private set

    fun build() {
      count.fill(0)
      for (l in lens) count[l.toInt() and 0xff]++
      count[0] = 0
      var allZero = true
      for (c in count) if (c != 0) allZero = false
      empty = allZero
      table.fill(0)
      if (empty) return
      var code = 0
      var kraft = 0
      for (len in 1..16) {
        code = (code + count[len - 1]) shl 1
        first[len] = code
        kraft += count[len] shl (16 - len)
      }
      if (kraft != 1 shl 16) throw IllegalStateException("LZX: incomplete or over-subscribed Huffman table ($kraft)")
      offset[1] = 0
      for (len in 1..16) offset[len + 1] = offset[len] + count[len]
      val next = offset.copyOf()
      for (s in lens.indices) {
        val l = lens[s].toInt() and 0xff
        if (l != 0) sorted[next[l]++] = s
      }
      for (len in 1..16) {
        for (k in 0 until count[len]) {
          val c = first[len] + k
          val sym = sorted[offset[len] + k]
          if (len <= tableBits) {
            val base = c shl (tableBits - len)
            val fill = 1 shl (tableBits - len)
            val entry = (len shl 16) or sym
            for (i in 0 until fill) table[base + i] = entry
          } else {
            table[c ushr (len - tableBits)] = OVERFLOW
          }
        }
      }
    }
  }

  private class BitReader {
    private var buf: ByteArray = ByteArray(0)
    var pos = 0
      private set
    private var end = 0
    var bitbuf = 0L
    var bitsLeft = 0

    fun reset(b: ByteArray) {
      buf = b
      pos = 0
      end = b.size
      bitbuf = 0
      bitsLeft = 0
    }

    private fun ensure(n: Int) {
      while (bitsLeft < n) {
        val p = pos
        val lo = if (p < end) buf[p].toInt() and 0xff else 0
        val hi = if (p + 1 < end) buf[p + 1].toInt() and 0xff else 0
        if (p > end + 4) throw IllegalStateException("LZX: read past end of compressed block")
        pos = p + 2
        // Bits are consumed from the top, so the new 16 bits go below what is already buffered.
        bitbuf = bitbuf or ((((hi shl 8) or lo).toLong() and 0xffff) shl (48 - bitsLeft))
        bitsLeft += 16
      }
    }

    fun readBits(n: Int): Int {
      if (n == 0) return 0
      ensure(n)
      val v = (bitbuf ushr (64 - n)).toInt() and ((1 shl n) - 1)
      bitbuf = bitbuf shl n
      bitsLeft -= n
      return v
    }

    fun decode(h: Huffman): Int {
      if (h.empty) throw IllegalStateException("LZX: decode from empty Huffman table")
      ensure(16)
      val e = h.table[(bitbuf ushr (64 - h.tableBits)).toInt() and ((1 shl h.tableBits) - 1)]
      if (e != OVERFLOW && e != 0) {
        val len = e ushr 16
        bitbuf = bitbuf shl len
        bitsLeft -= len
        return e and 0xffff
      }
      val peek = (bitbuf ushr 48).toInt() and 0xffff
      for (len in h.tableBits + 1..16) {
        val c = peek ushr (16 - len)
        val idx = c - h.first[len]
        if (idx >= 0 && idx < h.count[len]) {
          bitbuf = bitbuf shl len
          bitsLeft -= len
          return h.sorted[h.offset[len] + idx]
        }
      }
      throw IllegalStateException("LZX: invalid Huffman code")
    }

    /** Discard buffered bits up to the next 16-bit boundary (always consuming at least one bit). */
    fun alignForRawData() {
      if (bitsLeft == 0) ensure(16)
      bitsLeft = 0
      bitbuf = 0
    }

    fun rawByte(): Byte {
      if (pos >= end) throw IllegalStateException("LZX: uncompressed block data truncated")
      return buf[pos++]
    }
  }

  private companion object {
    const val NUM_CHARS = 256
    const val PRETREE_NUM = 20
    const val ALIGNED_NUM = 8
    const val LENGTH_NUM = 249
    const val MIN_MATCH = 2
    const val BLOCK_VERBATIM = 1
    const val BLOCK_ALIGNED = 2
    const val BLOCK_UNCOMPRESSED = 3
    const val OVERFLOW = -1

    val POSITION_SLOTS = mapOf(15 to 30, 16 to 32, 17 to 34, 18 to 36, 19 to 38, 20 to 42, 21 to 50)

    val EXTRA_BITS = IntArray(52)
    val POSITION_BASE = LongArray(52)

    init {
      run {
        var j = 0
        var i = 0
        while (i < 52) {
          EXTRA_BITS[i] = j
          EXTRA_BITS[i + 1] = j
          if (i != 0 && j < 17) j++
          i += 2
        }
      }
      run {
        var base = 0L
        for (k in 0 until 52) {
          POSITION_BASE[k] = base
          base += 1L shl EXTRA_BITS[k]
        }
      }
    }
  }
}

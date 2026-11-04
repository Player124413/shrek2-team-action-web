package org.shrek2.launcher.install

/**
 * MD5 (RFC 1321), used to verify installed files against the MSI's MsiFileHash table.
 *
 * `java.security.MessageDigest` would do, but the install runs on a thread that is already holding the
 * disc image open and the digest also runs inside the JVM unit tests, where this keeps the behaviour
 * identical to `installer/src/md5.ts` (which it is checked against).
 */
object Md5 {
  private val S = intArrayOf(
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  )
  private val K = IntArray(64) { i -> (Math.abs(Math.sin((i + 1).toDouble())) * 4294967296.0).toLong().toInt() }

  fun digest(data: ByteArray): ByteArray {
    val n = data.size
    val padded = ByteArray(((n + 8) shr 6) * 64 + 64)
    System.arraycopy(data, 0, padded, 0, n)
    padded[n] = 0x80.toByte()
    val bits = n.toLong() * 8
    val lenAt = padded.size - 8
    for (i in 0 until 8) padded[lenAt + i] = (bits ushr (8 * i)).toByte()

    var a0 = 0x67452301
    var b0 = -0x10325477 // 0xefcdab89
    var c0 = -0x67452302 // 0x98badcfe
    var d0 = 0x10325476
    val m = IntArray(16)
    var off = 0
    while (off < padded.size) {
      for (i in 0 until 16) {
        val o = off + i * 4
        m[i] = (padded[o].toInt() and 0xff) or ((padded[o + 1].toInt() and 0xff) shl 8) or
          ((padded[o + 2].toInt() and 0xff) shl 16) or ((padded[o + 3].toInt() and 0xff) shl 24)
      }
      var a = a0
      var b = b0
      var c = c0
      var d = d0
      for (i in 0 until 64) {
        val f: Int
        val g: Int
        when {
          i < 16 -> {
            f = (b and c) or (b.inv() and d)
            g = i
          }
          i < 32 -> {
            f = (d and b) or (d.inv() and c)
            g = (5 * i + 1) and 15
          }
          i < 48 -> {
            f = b xor c xor d
            g = (3 * i + 5) and 15
          }
          else -> {
            f = c xor (b or d.inv())
            g = (7 * i) and 15
          }
        }
        val t = d
        d = c
        c = b
        val x = a + f + K[i] + m[g]
        b = b + Integer.rotateLeft(x, S[i])
        a = t
      }
      a0 += a
      b0 += b
      c0 += c
      d0 += d
      off += 64
    }
    val out = ByteArray(16)
    for ((i, v) in intArrayOf(a0, b0, c0, d0).withIndex()) {
      out[i * 4] = v.toByte()
      out[i * 4 + 1] = (v ushr 8).toByte()
      out[i * 4 + 2] = (v ushr 16).toByte()
      out[i * 4 + 3] = (v ushr 24).toByte()
    }
    return out
  }

  fun hex(b: ByteArray): String {
    val sb = StringBuilder(b.size * 2)
    for (x in b) {
      val v = x.toInt() and 0xff
      sb.append(HEX[v ushr 4]).append(HEX[v and 0xf])
    }
    return sb.toString()
  }

  private const val HEX = "0123456789abcdef"
}

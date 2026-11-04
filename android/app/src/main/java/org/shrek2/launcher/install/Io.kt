package org.shrek2.launcher.install

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/**
 * Random-access byte sources and file sinks — the Android half of `installer/src/io.ts`.
 *
 * Sources are synchronous on purpose, exactly like the TypeScript ones: the parsers above read
 * sequentially, and on the device the backing store is a file (the disc image is streamed into the app's
 * cache first, because a `content://` document has no positional reads).
 */
interface ByteSource {
  val size: Long

  /** Read exactly [length] bytes at [offset]; throws `IndexOutOfBoundsException` if out of range. */
  fun read(offset: Long, length: Int): ByteArray

  fun close() {}
}

class MemorySource(private val bytes: ByteArray) : ByteSource {
  override val size: Long get() = bytes.size.toLong()

  override fun read(offset: Long, length: Int): ByteArray {
    checkRange(offset, length.toLong(), size)
    return bytes.copyOfRange(offset.toInt(), offset.toInt() + length)
  }
}

/** A window `[start, start + size)` of another source. */
class SliceSource(private val base: ByteSource, private val start: Long, override val size: Long) : ByteSource {
  init {
    checkRange(start, size, base.size)
  }

  override fun read(offset: Long, length: Int): ByteArray {
    checkRange(offset, length.toLong(), size)
    return base.read(start + offset, length)
  }
}

class FileSource(private val file: File) : ByteSource {
  private val raf = RandomAccessFile(file, "r")
  override val size: Long = raf.length()

  @Synchronized
  override fun read(offset: Long, length: Int): ByteArray {
    checkRange(offset, length.toLong(), size)
    val out = ByteArray(length)
    raf.seek(offset)
    raf.readFully(out)
    return out
  }

  override fun close() = raf.close()
}

fun checkRange(offset: Long, length: Long, size: Long) {
  if (offset < 0 || length < 0 || offset + length > size) {
    throw IndexOutOfBoundsException("read [$offset, +$length) outside source of size $size")
  }
}

/** Destination for installed files; paths use forward slashes, relative to the install root. */
interface FileSink {
  fun writeFile(path: String, data: ByteArray)
}

/**
 * Writes into a directory. The install tree is the app's private storage, so the sink can be plain
 * `java.io`; each file is written under a temporary name and renamed, so an install that is killed
 * half-way never leaves a file that looks complete.
 */
class DirSink(private val root: File) : FileSink {
  var files = 0
    private set
  var bytes = 0L
    private set

  override fun writeFile(path: String, data: ByteArray) {
    val out = File(root, path)
    val dir = out.parentFile
    if (dir != null && !dir.isDirectory && !dir.mkdirs()) throw IOException("cannot create $dir")
    val tmp = File(dir, out.name + ".part")
    try {
      tmp.outputStream().use { it.write(data) }
      if (out.exists() && !out.delete()) throw IOException("cannot replace $path")
      if (!tmp.renameTo(out)) throw IOException("cannot write $path")
    } finally {
      if (tmp.exists()) tmp.delete()
    }
    files++
    bytes += data.size
  }
}

/** Little-endian readers over a `ByteArray`, matching `installer/src/io.ts`. */
object Bytes {
  fun u16(b: ByteArray, o: Int): Int = (b[o].toInt() and 0xff) or ((b[o + 1].toInt() and 0xff) shl 8)

  fun u32(b: ByteArray, o: Int): Long =
    (b[o].toLong() and 0xff) or ((b[o + 1].toLong() and 0xff) shl 8) or
      ((b[o + 2].toLong() and 0xff) shl 16) or ((b[o + 3].toLong() and 0xff) shl 24)

  fun i32(b: ByteArray, o: Int): Int = u32(b, o).toInt()

  fun latin1(b: ByteArray, start: Int, end: Int): String {
    val sb = StringBuilder(end - start)
    for (i in start until minOf(end, b.size)) sb.append((b[i].toInt() and 0xff).toChar())
    return sb.toString()
  }

  /** NUL-terminated string starting at [o]. */
  fun cstr(b: ByteArray, o: Int, max: Int = b.size - o): String {
    var e = o
    val lim = minOf(b.size, o + max)
    while (e < lim && b[e].toInt() != 0) e++
    return latin1(b, o, e)
  }
}

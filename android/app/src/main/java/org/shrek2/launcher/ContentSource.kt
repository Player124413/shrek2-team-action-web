package org.shrek2.launcher

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import org.shrek2.launcher.install.ByteSource
import org.shrek2.launcher.install.DiscException
import org.shrek2.launcher.install.checkRange

/**
 * A `content://` document, read in windows instead of being copied first.
 *
 * The launcher used to stream the whole image into the cache. Two things were wrong with that: on a
 * 548 MB disc it needed half a gigabyte of free space, and a copy that stopped early produced a 20 MB
 * "image" out of a 548 MB one -- which then failed to install with an error about a truncated disc.
 *
 * A document has no positional read, so this asks the provider for a window (64 KiB by default) and
 * serves whatever falls inside it from memory. ISO blocks are 2048 bytes, so one window covers 32 of
 * them; the cabinet stream's megabytes are walked with consecutive windows, each continuing where the
 * previous one ended. Nothing is written to disk.
 */
class ContentSource(private val resolver: ContentResolver, private val uri: Uri) : ByteSource {

  /** How much of the document to ask for at a time. Small enough to be cheap, large enough to hide the round trip. */
  private var windowBytes = 64 * 1024

  override val size: Long = runCatching {
    resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
      if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else 0L
    } ?: 0L
  }.getOrDefault(0L)

  /** Where the current window starts, and the bytes it holds (possibly empty). */
  private var windowAt = 0L
  private var window = ByteArray(0)

  @Synchronized
  override fun read(offset: Long, length: Int): ByteArray {
    checkRange(offset, length.toLong(), size)
    val out = ByteArray(length)
    var done = 0
    while (done < length) {
      val at = offset + done
      if (at < windowAt || at >= windowAt + window.size) {
        // A provider that refuses to seek can only be read forwards from the start. `openInputStream`
        // is a stream; asking it to skip is the only positional read available, and it is linear, so a
        // provider that cannot do it makes the install slow instead of wrong.
        window = readWindow(at, minOf(windowBytes.toLong(), size - at).toInt())
        windowAt = at
        if (window.isEmpty()) {
          // The provider was asked for bytes it has already promised by its own length. In practice that
          // is a file that is still arriving (a cloud provider) or one whose access was cut off -- and on
          // the way it looks exactly like a disc image that ends in the middle.
          throw DiscException(
            "the disc image could not be read past byte $at of $size: the file is incomplete or the app " +
              "lost access to it. If it is on a cloud drive, download it to the device first; otherwise copy " +
              "the image again and retry",
          )
        }
        // The window was cut short (the end of the file, or a provider limitation): keep going from there.
        windowBytes = maxOf(window.size, 4096)
      }
      val from = (at - windowAt).toInt()
      val take = minOf(length - done, window.size - from)
      System.arraycopy(window, from, out, done, take)
      done += take
    }
    return out
  }

  private fun readWindow(offset: Long, length: Int): ByteArray {
    val input = resolver.openInputStream(uri) ?: return ByteArray(0)
    return input.use { stream ->
      var skipped = 0L
      while (skipped < offset) {
        val n = stream.skip(offset - skipped)
        if (n <= 0) {
          // Some providers do not support skip: read and discard instead.
          if (stream.read() < 0) return ByteArray(0)
          skipped++
        } else {
          skipped += n
        }
      }
      val buffer = ByteArray(length)
      var filled = 0
      while (filled < length) {
        val n = stream.read(buffer, filled, length - filled)
        if (n <= 0) break
        filled += n
      }
      buffer.copyOf(filled)
    }
  }
}

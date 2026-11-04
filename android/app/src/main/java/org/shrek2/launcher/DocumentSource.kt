package org.shrek2.launcher

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import java.io.InputStream
import org.shrek2.launcher.install.ByteSource
import org.shrek2.launcher.install.checkRange

/**
 * A `content://` document read in windows, without copying it anywhere first.
 *
 * Two things in this app read a file the player picked -- the disc installer and the archive unpacker --
 * and neither should cost half a gigabyte of cache: a copy that stops early is exactly how a 548 MB disc
 * image once reached the installer as a 20 MB file.
 *
 * A document has no positional read, so a window is fetched by opening the stream and skipping to the
 * offset (the only seek a provider offers); the bytes are then served from memory. Readers that go forward
 * -- every one in this app does, in 2048-byte sectors and in archive entries -- hit the window they already
 * have, so the number of provider round trips is the file size divided by [window].
 */
open class DocumentSource(
  private val resolver: ContentResolver,
  private val uri: Uri,
  private val window: Int = DEFAULT_WINDOW,
) : ByteSource {

  override val size: Long = runCatching {
    resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
      if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else 0L
    } ?: 0L
  }.getOrDefault(0L)

  /** The display name, for messages: "disc.iso", "game.tar.gz". */
  val name: String = runCatching {
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
    }
  }.getOrNull() ?: "the selected file"

  private var windowAt = 0L
  private var windowBytes = ByteArray(0)

  @Synchronized
  override fun read(offset: Long, length: Int): ByteArray = readChecked(offset, length, { checkRange(it, length.toLong(), size) })

  /** Read without the disc-specific wording in the message: an archive is not a disc image. */
  private fun readChecked(offset: Long, length: Int, check: (Long) -> Unit): ByteArray {
    check(offset)
    val out = ByteArray(length)
    var done = 0
    while (done < length) {
      val at = offset + done
      if (at < windowAt || at >= windowAt + windowBytes.size) {
        val want = minOf(window.toLong(), size - at).coerceAtLeast(1).toInt()
        windowBytes = fetch(at, want)
        windowAt = at
        if (windowBytes.isEmpty()) {
          throw DiscException(
            "could not read \"$name\" past byte $at of $size: the file is incomplete or the app lost " +
              "access to it. If it is on a cloud drive, download it to the device first; otherwise copy " +
              "the file again and retry",
          )
        }
      }
      val from = (at - windowAt).toInt()
      val take = minOf(length - done, windowBytes.size - from)
      System.arraycopy(windowBytes, from, out, done, take)
      done += take
    }
    return out
  }

  private fun fetch(offset: Long, length: Int): ByteArray {
    val input: InputStream = resolver.openInputStream(uri) ?: return ByteArray(0)
    return input.use { stream ->
      var skipped = 0L
      while (skipped < offset) {
        val n = stream.skip(offset - skipped)
        if (n <= 0) {
          // A provider that does not support skip: read and discard. Slower, still correct.
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

  companion object {
    /** 64 KiB: one provider round trip per 32 ISO sectors, or per few archive entries. */
    const val DEFAULT_WINDOW = 64 * 1024
  }
}

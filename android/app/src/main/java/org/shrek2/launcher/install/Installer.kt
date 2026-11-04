package org.shrek2.launcher.install

import java.io.IOException

/**
 * Installs Shrek 2 Team Action from the player's own disc image: reads the ISO, the MSI database and
 * the LZX cabinet, and writes the INSTALLDIR tree (e.g. `Game/Chars/...`) to a sink.
 *
 * A port of `installer/src/install.ts`, which the web build uses, so the phone and the browser accept
 * exactly the same discs and produce exactly the same files.
 */
object Installer {

  const val PRODUCT_NAME = "Shrek 2 Team Action"

  /**
   * Files replaced on the disc after the MSI was built (stored uncompressed, newer timestamps), so
   * their MsiFileHash describes an older build. MD5s of known retail copies.
   */
  private val LATE_MASTERED_MD5 = mapOf(
    "Game/Shrek 2.exe" to listOf("c3bdca1f047e722e72afaa899841ed5c"), // EN retail, PE timestamp 2004-10-07
  )

  enum class Phase { SCAN, EXTRACT, COPY, DONE }

  class Progress(val phase: Phase, val done: Int, val total: Int, val path: String?)

  class Report(
    val volumeId: String,
    val written: Int,
    val bytes: Long,
    val skipped: Int,
    val verified: Int,
    val mismatches: List<String>,
    val registry: List<MsiRegistryValue>,
  ) {
    /** Human-readable result for the launcher: one line per problem found while verifying. */
    fun summary(): String = buildString {
      append("Installed $written files (${bytes / 1048576} MB) from disc $volumeId")
      if (verified > 0) append(", $verified verified")
      if (mismatches.isNotEmpty()) {
        append(". ${mismatches.size} file(s) did not match the disc's checksums: ")
        append(mismatches.take(3).joinToString("; "))
        if (mismatches.size > 3) append("; ...")
      }
    }
  }

  class Disc(val image: IsoImage, val db: MsiDatabase, val layout: MsiLayout)

  /** Find the game's MSI on the disc; throws when the image is a different product. */
  fun openDisc(iso: ByteSource): Disc {
    val image = IsoImage(iso)
    for (e in image.list("")) {
      if (e.isDir || !e.name.lowercase().endsWith(".msi")) continue
      val db = MsiDatabase(image.open(e.name).read(0, e.size.toInt()))
      val layout = readLayout(db)
      if (layout.productName == PRODUCT_NAME) return Disc(image, db, layout)
    }
    throw IOException("no $PRODUCT_NAME installer database found on this disc (volume ${image.volumeId})")
  }

  /**
   * Install every file of [disc] into [sink].
   *
   * Compressed files come out of the cabinets named by the MSI Media table (CAB members are keyed by the
   * MSI File key, and the i-th member of a cabinet has sequence `previous LastSequence + i + 1`);
   * uncompressed ones are stored loose on the disc at their MSI source path.
   */
  fun install(disc: Disc, sink: FileSink, onProgress: (Progress) -> Unit = {}): Report {
    val image = disc.image
    val layout = disc.layout
    var written = 0
    var bytes = 0L
    var verified = 0
    val mismatches = ArrayList<String>()
    val wanted = layout.files.filter { it.installPath != null }
    val total = wanted.size
    val bySeq = HashMap<Long, MsiFile>()
    for (f in layout.files) bySeq[f.sequence] = f
    val byKey = HashMap<String, MsiFile>()
    for (f in layout.files) byKey[f.key] = f

    fun emit(f: MsiFile, data: ByteArray) {
      if (data.size.toLong() != f.size) {
        mismatches += "${f.installPath}: size ${data.size} != ${f.size}"
      } else if (f.md5 != null) {
        val got = Md5.hex(Md5.digest(data))
        val late = LATE_MASTERED_MD5[f.installPath]?.contains(got) == true
        if (got == Md5.hex(f.md5) || late) verified++ else mismatches += "${f.installPath}: MD5 mismatch ($got)"
      }
      sink.writeFile(f.installPath!!, data)
      written++
      bytes += data.size
      onProgress(Progress(if (f.compressed) Phase.EXTRACT else Phase.COPY, written, total, f.installPath))
    }

    var prevLast = 0L
    for (m in layout.media.sortedBy { it.diskId }) {
      val cabinet = m.cabinet
      if (!cabinet.isNullOrEmpty()) {
        val cabName = cabinet.removePrefix("#")
        val cab = Cabinet(image.open(cabName))
        val members = cab.files.mapIndexed { i, cf -> cf to (byKey[cf.name] ?: bySeq[prevLast + i + 1]) }
        for (folder in cab.folders) {
          val inFolder = members.filter { (cf, f) -> cf.folder == folder.index && f != null && f.installPath != null }
          if (inFolder.isEmpty()) continue
          val data = cab.extractFolder(folder.index)
          for ((cf, f) in inFolder) {
            val start = cf.offsetInFolder.toInt()
            val end = minOf(data.size, start + cf.size.toInt())
            emit(f!!, if (start <= end) data.copyOfRange(start, end) else ByteArray(0))
          }
        }
      }
      prevLast = m.lastSequence
    }

    // Uncompressed files are stored loose on the disc at their MSI source path.
    for (f in wanted.filter { !it.compressed }) {
      val e = image.lookup(f.sourcePath)
      if (e == null || e.isDir) {
        mismatches += "${f.installPath}: source not found on disc at ${f.sourcePath}"
        continue
      }
      emit(f, image.open(f.sourcePath).read(0, e.size.toInt()))
    }
    onProgress(Progress(Phase.DONE, written, total, null))
    return Report(
      volumeId = image.volumeId,
      written = written,
      bytes = bytes,
      skipped = layout.files.size - written,
      verified = verified,
      mismatches = mismatches,
      registry = layout.registry,
    )
  }
}

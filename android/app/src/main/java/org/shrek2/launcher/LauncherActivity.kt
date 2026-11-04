package org.shrek2.launcher

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import org.shrek2.launcher.install.DirSink
import org.shrek2.launcher.install.FileSource
import org.shrek2.launcher.install.Installer
import java.io.File

/**
 * Start-up screen: installs the game from the player's own disc image and starts it.
 *
 * Two ways to get the game there, and the second is the default when it is available:
 *
 *  1. the APK may carry an installed copy (`BundledGame`), which is unpacked on the first start -- the
 *     player installs the app and plays;
 *  2. "Install from your own disc" asks for the *ISO image* of the retail disc and installs out of it
 *     straight from the document (ISO 9660 -> MSI -> LZX cabinet, see `install/`), nothing copied first.
 *
 * Graphics settings live here too: the original Launcher's resolution and effects switches, written to
 * the registry file the game reads at start-up. Everything is local — no network code anywhere.
 */
class LauncherActivity : AppCompatActivity() {

  private lateinit var status: TextView
  private lateinit var install: Button
  private lateinit var installArchive: Button
  private lateinit var play: Button
  private lateinit var settingsBox: LinearLayout
  private lateinit var progress: ProgressBar
  private lateinit var progressText: TextView
  private lateinit var distanceBar: SeekBar

  private var resolution = 2
  private val switches = HashMap<Int, CheckBox>() // option bit -> checkbox

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val g = loadGraphics()
    resolution = g.resolution

    status = TextView(this).apply { textSize = 16f }
    progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
      max = 100
      visibility = View.GONE
    }
    progressText = TextView(this).apply {
      textSize = 13f
      visibility = View.GONE
    }
    install = Button(this).apply {
      text = getString(R.string.install_title)
      setOnClickListener { pickDisc() }
    }
    // The path most players have: a copy of the game they already installed, zipped.
    installArchive = Button(this).apply {
      text = getString(R.string.install_archive_title)
      setOnClickListener { pickArchive() }
    }
    play = Button(this).apply {
      text = getString(R.string.play)
      setOnClickListener { startActivity(Intent(this@LauncherActivity, GameActivity::class.java)) }
    }

    // The settings block is created first and filled afterwards: `addOption` appends to it, and a
    // `lateinit` that is only assigned when the whole `apply` block has run is not initialised yet
    // inside it (that ordering crashed the activity before the screen appeared).
    settingsBox = LinearLayout(this)
    settingsBox.orientation = LinearLayout.VERTICAL
    settingsBox.addView(TextView(this).apply {
      text = getString(R.string.settings_graphics)
      textSize = 20f
      setPadding(0, 24, 0, 8)
    })
    settingsBox.addView(TextView(this).apply {
      text = getString(R.string.settings_resolution)
      textSize = 14f
    })
    settingsBox.addView(Button(this).apply {
      id = RESOLUTION_BUTTON_ID
      text = Settings.RESOLUTIONS[resolution]
      setOnClickListener {
        resolution = (resolution + 1) % Settings.RESOLUTIONS.size
        text = Settings.RESOLUTIONS[resolution]
        saveGraphics()
      }
    })
    addOption(g, Settings.OPT_SHADOWS, R.string.settings_shadows)
    addOption(g, Settings.OPT_ANTIALIAS, R.string.settings_antialiasing)
    addOption(g, Settings.OPT_CLIPPING, R.string.settings_clipping)
    settingsBox.addView(TextView(this).apply {
      text = getString(R.string.settings_distance)
      textSize = 14f
      setPadding(0, 16, 0, 0)
    })
    distanceBar = SeekBar(this).apply {
      id = DISTANCE_ID
      max = 100
      progress = g.distance
      setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
        override fun onProgressChanged(bar: SeekBar, value: Int, fromUser: Boolean) {}
        override fun onStartTrackingTouch(bar: SeekBar) {}
        override fun onStopTrackingTouch(bar: SeekBar) = saveGraphics()
      })
    }
    settingsBox.addView(distanceBar)
    settingsBox.addView(TextView(this).apply {
      text = getString(R.string.settings_hint)
      textSize = 12f
      setPadding(0, 24, 0, 0)
    })

    val column = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(48, 48, 48, 48)
      addView(TextView(this@LauncherActivity).apply {
        text = getString(R.string.app_name)
        textSize = 26f
      })
      addView(status, matchWidth(top = 24))
      addView(progress, matchWidth(top = 16))
      addView(progressText, matchWidth(top = 4))
      addView(install, matchWidth(top = 24))
      addView(installArchive, matchWidth(top = 8))
      addView(play, matchWidth(top = 12))
      addView(settingsBox)
    }
    setContentView(ScrollView(this).apply { addView(column) })
  }

  private fun addOption(g: Settings.Graphics, bit: Int, label: Int) {
    val on = g.options() and bit != 0
    val box = CheckBox(this).apply {
      text = getString(label)
      isChecked = on
      setOnCheckedChangeListener { _, _ -> saveGraphics() }
    }
    switches[bit] = box
    settingsBox.addView(box)
  }

  private fun matchWidth(top: Int = 0) =
    LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
    ).apply { topMargin = top }

  override fun onResume() {
    super.onResume()
    refresh()
    // The APK may carry an installed copy of the game (tools/pack-game.mjs). Unpacking it is a one-time
    // copy of a few hundred megabytes on the first start, so it runs off the UI thread and the screen says
    // what is happening instead of looking empty.
    if (!installing && !InstallFiles.installed(this) && BundledGame.bundled(this)) unpackBundled()
  }

  /** Copy the game packaged in the APK into the install directory, showing progress. */
  private fun unpackBundled() {
    installing = true
    install.isEnabled = false
    play.isEnabled = false
    progress.visibility = View.VISIBLE
    progress.progress = 0
    progressText.visibility = View.VISIBLE
    progressText.text = getString(R.string.install_unpacking)
    Thread {
      var failure: String? = null
      try {
        BundledGame.unpack(this) { done, total ->
          val percent = if (total > 0) done * 100 / total else 0
          main {
            progress.progress = percent
            progressText.text = getString(R.string.install_writing, done, total)
          }
        }
      } catch (e: Exception) {
        failure = e.message ?: e.toString()
      }
      main {
        installing = false
        install.isEnabled = true
        progress.visibility = View.GONE
        progressText.visibility = if (failure == null) View.GONE else View.VISIBLE
        if (failure != null) progressText.text = getString(R.string.install_failed, failure)
        if (InstallFiles.installed(this)) {
          // The registry the game reads has to exist before the first start; the bundled tree does not
          // carry one (settings are the player's, not the disc's).
          loadGraphics()
        }
        refresh()
      }
    }.start()
  }

  private fun refresh() {
    if (installing) return
    val installed = InstallFiles.installed(this)
    val compiled = InstallFiles.compiled(this)
    val bundled = BundledGame.bundled(this)
    play.isEnabled = installed && compiled
    // With the game inside the APK there is nothing to install: the disc path stays available, but as a
    // secondary option, because a player who owns a disc should still be able to use it.
    install.visibility = if (installed && bundled) View.GONE else View.VISIBLE
    installArchive.visibility = install.visibility
    status.text = when {
      !installed && bundled -> getString(R.string.status_unpacking)
      !installed -> getString(R.string.status_not_installed)
      !compiled -> getString(R.string.status_needs_compile)
      else -> getString(R.string.status_ready, InstallFiles.imageBytes(this) / 1048576)
    }
  }

  // ---- Graphics settings ---------------------------------------------------------------------------

  private fun loadGraphics(): Settings.Graphics {
    val registry = Registry.load(registryFile())
    Settings.prepareDefaults(registry)
    Registry.save(registryFile(), registry)
    return Settings.read(registry)
  }

  /** Read every switch back, write the registry, and keep the rest of the file as it was. */
  private fun saveGraphics() {
    val registry = Registry.load(registryFile())
    var options = 0
    for ((bit, box) in switches) if (box.isChecked) options = options or bit
    val g = Settings.Graphics(
      resolution = resolution,
      shadows = options and Settings.OPT_SHADOWS != 0,
      antiAliasing = options and Settings.OPT_ANTIALIAS != 0,
      clipping = options and Settings.OPT_CLIPPING != 0,
      distance = if (::distanceBar.isInitialized) distanceBar.progress else Settings.defaults().distance,
    )
    Settings.write(registry, g)
    Registry.save(registryFile(), registry)
  }

  private fun registryFile(): File = File(noBackupFilesDir, "registry.txt")

  // ---- Installing from a disc image ----------------------------------------------------------------

  private fun pickDisc() {
    // ACTION_OPEN_DOCUMENT, not GET_CONTENT: it gives a stable URI and a read grant we can keep for the
    // length of the install (a multi-hundred-megabyte cabinet read).
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      // Most file managers report an ISO as application/octet-stream or octet-stream; the hint helps
      // the picker put disk images first without hiding anything.
      putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/octet-stream", "application/x-iso9660-image", "application/x-cd-image"))
      putExtra(Intent.EXTRA_TITLE, getString(R.string.pick_disc))
    }
    @Suppress("DEPRECATION")
    startActivityForResult(Intent.createChooser(intent, getString(R.string.install_title)), REQUEST_DOCUMENT)
  }

  /**
   * Pick a `zip`/`tar`/`tar.gz` of an installed copy of the game and unpack it.
   *
   * `application/*` plus the common archive types, but `*/*` is included because many file managers report a
   * `.tar.gz` as octet-stream; the format is sniffed from the bytes anyway, so the picker cannot get it
   * wrong -- only the player can, and then the message says what the file actually looks like.
   */
  private fun pickArchive() {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      putExtra(
        Intent.EXTRA_MIME_TYPES,
        arrayOf("application/zip", "application/x-zip-compressed", "application/gzip", "application/x-gzip", "application/x-tar"),
      )
      putExtra(Intent.EXTRA_TITLE, getString(R.string.pick_archive))
    }
    @Suppress("DEPRECATION")
    startActivityForResult(Intent.createChooser(intent, getString(R.string.install_archive_title)), REQUEST_ARCHIVE)
  }

  @Deprecated("document URI result")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (resultCode != Activity.RESULT_OK) return
    val uri = data?.data ?: return
    runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    when (requestCode) {
      REQUEST_DOCUMENT -> installDisc(uri)
      REQUEST_ARCHIVE -> installArchive(uri)
    }
  }

  /**
   * Install straight out of the document the player picked. Nothing is copied: the disc image is read
   * through [ContentSource], which asks the provider for windows of it, so a 548 MB image needs no space
   * in the cache and cannot be silently truncated on the way (the copy that did exactly that is what made
   * a 548 MB disc look like a 20 MB one).
   *
   * Everything runs on a worker thread; the UI thread only sees the progress bar and the result.
   */
  private fun installDisc(uri: Uri) {
    installing = true
    install.isEnabled = false
    progress.visibility = View.VISIBLE
    progress.progress = 0
    progressText.visibility = View.VISIBLE
    progressText.text = getString(R.string.install_scanning)

    Thread {
      installFrom(uri) { failure -> lastError = failure }
    }.start()
  }

  private var lastError: String? = null

  /** The install itself; [onDone] receives the error message, or null when it succeeded. */
  private fun installFrom(uri: Uri, onDone: (String?) -> Unit) {
    var failure: String? = null
    var summary: String? = null
    val source = DocumentSource(contentResolver, uri)
    try {
      val root = InstallFiles.installDir(this)
      root.mkdirs()
      val disc = Installer.openDisc(source)
      val report = Installer.install(disc, DirSink(root)) { p ->
        val done = if (p.total > 0) p.done * 100 / p.total else 0
        main {
          progress.progress = done
          progressText.text = when (p.phase) {
            Installer.Phase.SCAN -> getString(R.string.install_scanning)
            else -> getString(R.string.install_writing, p.done, p.total)
          }
        }
      }
      summary = report.summary()
      // Files that did not match the disc's own checksums: report them, but keep the install -- the sizes
      // are compared too, so what is there is complete and the player can still play.
      if (report.mismatches.isNotEmpty()) {
        val warnings = getString(R.string.install_warnings, report.mismatches.take(3).joinToString("; "))
        main { progressText.text = warnings }
      }
      // The disc's own registry rows describe the Windows install (paths under C:), the game's settings
      // the launcher writes are the ones that matter here. The install directory and the cache are
      // created either way, so the game can start as soon as it is compiled.
      InstallFiles.prepare(this)
      loadGraphics()
    } catch (e: Exception) {
      failure = e.message ?: e.toString()
    } finally {
      source.close()
    }
    val done = summary ?: getString(R.string.install_done)
    onDone(failure)
    main {
      installing = false
      install.isEnabled = true
      progress.visibility = View.GONE
      if (failure != null) {
        progressText.text = getString(R.string.install_failed, failure)
      } else {
        progressText.text = done
      }
      refresh()
    }
  }

  /**
   * Unpack an installed copy of the game from the archive the player picked, straight out of the document.
   *
   * The archive is read where it is ([DocumentSource]), so a 500 MB zip starts unpacking immediately and
   * needs no cache space. Afterwards the same finishing steps as a disc install run: the directory layout
   * is the one the game expects, and the registry gets its first-run values.
   */
  private fun installArchive(uri: Uri) {
    installing = true
    install.isEnabled = false
    installArchive.isEnabled = false
    progress.visibility = View.VISIBLE
    progress.progress = 0
    progressText.visibility = View.VISIBLE
    progressText.text = getString(R.string.install_unpacking_archive)

    Thread {
      unpackArchive(uri) { failure ->
        main {
          installing = false
          install.isEnabled = true
          installArchive.isEnabled = true
          progress.visibility = View.GONE
          if (failure != null) progressText.text = getString(R.string.install_failed, failure)
          refresh()
        }
      }
    }.start()
  }

  /** The archive install itself; [onDone] receives the error message, or null. */
  private fun unpackArchive(uri: Uri, onDone: (String?) -> Unit) {
      var failure: String? = null
      var summary: String? = null
      val source = DocumentSource(contentResolver, uri)
      try {
        val root = InstallFiles.installDir(this)
        root.mkdirs()
        val result = ArchiveUnpacker.unpack(source, DirSink(root)) { done, total, name ->
          val percent = if (total > 0) done * 100 / total else 0
          main {
            progress.progress = percent
            progressText.text = getString(R.string.install_unpacking_file, name)
          }
        }
        if (!InstallFiles.installed(this)) {
          throw DiscException(
            getString(R.string.install_no_game_in_archive, source.name),
          )
        }
        // The archive is the player's own copy of an installed game: its settings are not in it, so the
        // first-run values (and the controller GUIDs) are written here, exactly like after a disc install.
        InstallFiles.prepare(this)
        loadGraphics()
        summary = getString(R.string.install_archive_done, result.files, result.bytes / 1048576, result.format)
      } catch (e: Exception) {
        failure = e.message ?: e.toString()
      } finally {
        source.close()
      }
      onDone(failure)
      if (failure == null) {
        val done = summary ?: getString(R.string.install_done)
        main { progressText.text = done }
      }
  }

  /** Synchronous variant of [installArchive] for the JVM harness: returns the error message, or null. */
  internal fun installArchiveForTest(uri: Uri): String? {
    var error: String? = null
    unpackArchive(uri) { error = it }
    return error
  }

  private fun main(block: () -> Unit) = runOnUiThread(block)

  /**
   * Runs one install synchronously and returns the error message, or null.
   *
   * Used by `tools/android-stubs-runtime.sh`: the launcher's install path (document -> installer ->
   * install directory) is the part a phone exercised, and a worker thread with a progress bar is not
   * something a JVM harness can wait for. The production path is [installDisc].
   */
  internal fun installForTest(uri: Uri): String? {
    var error: String? = null
    installFrom(uri) { error = it }
    return error
  }

  private var installing = false

  private companion object {
    const val REQUEST_DOCUMENT = 1
    const val REQUEST_ARCHIVE = 2
    const val RESOLUTION_BUTTON_ID = 0x7f000001
    const val DISTANCE_ID = 0x7f000002
  }
}

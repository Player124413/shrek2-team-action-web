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
 * "Install from your own disc" asks for the *ISO image* of the retail disc and installs the game files
 * straight out of it (ISO 9660 -> MSI database -> LZX cabinet, see `install/`). No desktop step and no
 * pre-installed folder: the player picks the image, the launcher writes `Game/...` into app-private
 * storage. The image is streamed into the cache directory first, because a `content://` document has no
 * positional reads and the installer needs random access; the copy is deleted as soon as it is done.
 *
 * Graphics settings live here too: the original Launcher's resolution and effects switches, written to
 * the registry file the game reads at start-up. Everything is local — no network code anywhere.
 */
class LauncherActivity : AppCompatActivity() {

  private lateinit var status: TextView
  private lateinit var install: Button
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
  }

  private fun refresh() {
    if (installing) return
    val installed = InstallFiles.installed(this)
    val compiled = InstallFiles.compiled(this)
    play.isEnabled = installed && compiled
    install.visibility = if (installed) View.GONE else View.VISIBLE
    status.text = when {
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

  @Deprecated("document URI result")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != REQUEST_DOCUMENT || resultCode != Activity.RESULT_OK) return
    val uri = data?.data ?: return
    runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    installDisc(uri)
  }

  /**
   * Copy the image into the cache directory, then install from it. Both halves run on a worker thread;
   * the UI thread only sees the progress bar and the final message.
   */
  private fun installDisc(uri: Uri) {
    installing = true
    install.isEnabled = false
    progress.visibility = View.VISIBLE
    progress.progress = 0
    progressText.visibility = View.VISIBLE
    progressText.text = getString(R.string.install_copying)

    Thread {
      val image = File(cacheDir, "disc.iso")
      var failure: String? = null
      try {
        val total = contentSize(uri)
        var copied = 0L
        contentResolver.openInputStream(uri)?.use { input ->
          image.outputStream().use { out ->
            val buffer = ByteArray(1 shl 20)
            while (true) {
              val n = input.read(buffer)
              if (n <= 0) break
              out.write(buffer, 0, n)
              copied += n
              if (total > 0) main {
                progress.progress = (copied * 40 / total).toInt() // the copy is the first 40 %
                progressText.text = getString(R.string.install_copying_percent, (copied * 100 / total).toInt())
              }
            }
          }
        } ?: throw IllegalStateException("cannot open the selected file")

        val root = InstallFiles.installDir(this)
        root.mkdirs()
        var summary: String? = null
        val source = FileSource(image)
        try {
          val disc = Installer.openDisc(source)
          val report = Installer.install(disc, DirSink(root)) { p ->
            val done = if (p.total > 0) 40 + p.done * 60 / p.total else 40
            main {
              progress.progress = done
              progressText.text = when (p.phase) {
                Installer.Phase.SCAN -> getString(R.string.install_scanning)
                else -> getString(R.string.install_writing, p.done, p.total)
              }
            }
          }
          summary = report.summary()
          // Files that did not match the disc's own checksums: report them, but keep the install --
          // the sizes are checked too, so what is there is complete, and the player may still play.
          if (report.mismatches.isNotEmpty()) {
            val warnings = getString(R.string.install_warnings, report.mismatches.take(3).joinToString("; "))
            main { progressText.text = warnings }
          }
        } finally {
          source.close()
        }
        // The disc's own registry rows describe the Windows install (paths under C:), the game's
        // settings the launcher writes are the ones that matter here. The install directory and the
        // cache are created either way, so the game can start as soon as it is compiled.
        InstallFiles.prepare(this)
        loadGraphics()
        val done = summary ?: getString(R.string.install_done)
        main { progressText.text = done }
      } catch (e: Exception) {
        failure = e.message ?: e.toString()
      } finally {
        image.delete() // never keep a copy of the player's disc
      }
      main {
        installing = false
        install.isEnabled = true
        progress.visibility = View.GONE
        if (failure != null) {
          progressText.text = getString(R.string.install_failed, failure)
        }
        refresh()
      }
    }.start()
  }

  private fun contentSize(uri: Uri): Long = runCatching {
    contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
      if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else 0L
    } ?: 0L
  }.getOrDefault(0L)

  private fun main(block: () -> Unit) = runOnUiThread(block)

  private var installing = false

  private companion object {
    const val REQUEST_DOCUMENT = 1
    const val RESOLUTION_BUTTON_ID = 0x7f000001
    const val DISTANCE_ID = 0x7f000002
  }
}

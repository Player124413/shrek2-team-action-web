package org.shrek2.launcher

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.io.File

/**
 * Start-up screen: checks the install, offers the installer, and starts the game.
 *
 * Everything this screen needs is one directory tree (see [InstallFiles]); there is no network code
 * anywhere in the app, and no game data is shipped inside the APK -- the player supplies their own
 * copy and it never leaves the device.
 */
class LauncherActivity : AppCompatActivity() {

  private lateinit var status: TextView
  private lateinit var install: Button
  private lateinit var play: Button
  private lateinit var compile: ProgressBar

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    status = TextView(this).apply { textSize = 16f }
    install = Button(this).apply {
      text = getString(R.string.install_title)
      setOnClickListener { pickDisc() }
    }
    play = Button(this).apply {
      text = "Play"
      setOnClickListener { startActivity(Intent(this@LauncherActivity, GameActivity::class.java)) }
    }
    compile = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
      isIndeterminate = true
      visibility = android.view.View.GONE
    }

    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(48, 48, 48, 48)
      addView(TextView(this@LauncherActivity).apply {
        text = getString(R.string.app_name)
        textSize = 26f
      })
      addView(status, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = 24 })
      addView(install, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = 32 })
      addView(play, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = 16 })
      addView(TextView(this@LauncherActivity).apply {
        text = getString(R.string.install_hint)
        textSize = 13f
        setPadding(0, 32, 0, 0)
      })
      addView(compile)
    }
    setContentView(layout)
  }

  override fun onResume() {
    super.onResume()
    refresh()
  }

  private fun refresh() {
    val installed = InstallFiles.installed(this)
    val compiled = InstallFiles.compiled(this)
    play.isEnabled = installed && compiled
    install.visibility = if (installed) android.view.View.GONE else android.view.View.VISIBLE
    status.text = when {
      !installed -> "Shrek 2 Team Action is not installed yet. Choose your own disc image to copy the game files into the app's private storage."
      !compiled -> "Game files are installed. Starting the game the first time compiles it for this device " +
        "(the same translation the desktop site does in the browser); this takes a few minutes and happens once."
      else -> "Ready: ${InstallFiles.imageBytes(this) / 1048576} MB of native code for this device."
    }
  }

  /**
   * The installer needs the game files somewhere it can read. Instead of pulling the ISO parser into
   * the app, the launcher points the player at the companion tool (`node aot/cli.ts image` after
   * `installer/src/cli.ts`): on a phone without a desktop this is the "share the installed folder"
   * path, and on a phone with one it is a single transfer.
   */
  private fun pickDisc() {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      @Suppress("DEPRECATION")
      startActivityForResult(intent, REQUEST_TREE)
    } else {
      status.text = "This build needs Android 8.0 or newer."
    }
  }

  @Deprecated("tree URI result")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != REQUEST_TREE || resultCode != Activity.RESULT_OK) return
    val uri: Uri = data?.data ?: return
    // Persist the permission so the copy can resume after a restart.
    runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    copyTree(uri)
  }

  /** Copies an already-installed directory tree into the app's private storage, off the UI thread. */
  private fun copyTree(uri: Uri) {
    compile.visibility = android.view.View.VISIBLE
    Thread {
      val root = noBackupFilesDir.absolutePath
      var files = 0
      fun copy(dir: android.net.Uri, rel: String) {
        contentResolver.openFileDescriptor(dir, "r") // fails for a directory on some providers: ignore
        val docId = android.provider.DocumentsContract.getTreeDocumentId(dir)
        val children = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(dir, docId)
        contentResolver.query(children, null, null, null, null)?.use { cursor ->
          val idCol = cursor.getColumnIndex(android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID)
          val nameCol = cursor.getColumnIndex(android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME)
          val typeCol = cursor.getColumnIndex(android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE)
          while (cursor.moveToNext()) {
            val id = cursor.getString(idCol)
            val name = cursor.getString(nameCol)
            val childRel = if (rel.isEmpty()) name else "$rel/$name"
            val child = android.provider.DocumentsContract.buildDocumentUriUsingTree(dir, id)
            if (cursor.getString(typeCol) == android.provider.DocumentsContract.Document.MIME_TYPE_DIR) {
              copy(child, childRel)
            } else {
              val tmp = File(cacheDir, "incoming")
              tmp.parentFile?.mkdirs()
              contentResolver.openInputStream(child)?.use { input -> tmp.outputStream().use { input.copyTo(it) } }
              if (InstallFiles.copyFile(root, childRel, tmp.absolutePath)) files++
              tmp.delete()
            }
          }
        }
      }
      runCatching { copy(uri, "") }
      runOnUiThread {
        compile.visibility = android.view.View.GONE
        refresh()
        status.text = "Copied $files files. ${if (InstallFiles.installed(this)) "" else "The game's executable was not found in that folder."}"
      }
    }.start()
  }

  private companion object {
    const val REQUEST_TREE = 1
  }
}

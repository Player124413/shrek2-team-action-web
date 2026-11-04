#!/usr/bin/env bash
# Runs the launcher's start-up code on a plain JVM, with no phone and no Android SDK.
#
# `tools/android-stubs.sh` only *type-checks* against the Android API. That is not enough: the launcher
# crashed the moment it was opened, and the crash was in code that compiles perfectly -- an ordering bug
# (`settingsBox` was still empty when its first switch was added to it, so the switch went onto the
# window root and `View already has a parent` was thrown). A type check cannot see that; running
# `onCreate()` can.
#
# So this script provides a small *behaving* stand-in for the framework it touches (views, strings,
# logging, threads, prefs) and calls the real `LauncherActivity.onCreate` / `onResume`, then pokes every
# control it built. Nothing is mocked away that the start-up path actually uses, and any exception is a
# failure: that is exactly what the phone would do -- minus the crash dialog.
#
# Usage: tools/android-stubs-runtime.sh [--keep] [disc.iso]
#   KOTLINC=/path/to/kotlinc (default: kotlinc on PATH)
#
# With a disc image (the corpus: `node runtime/test/cab-lzx-corpus.mjs --out <dir>` then pass
# `<dir>/shrek2.iso`) it also drives the whole install path through the launcher: a `content://`
# document -> installer -> install directory. `tools/installer-test.sh` does exactly that, so CI covers
# both the installer and the screen that starts it.
set -euo pipefail

cd "$(dirname "$0")/.."
KOTLINC="${KOTLINC:-kotlinc}"
command -v "$KOTLINC" > /dev/null || { echo "kotlinc not found: set KOTLINC=/path/to/kotlinc" >&2; exit 1; }

OUT="$(mktemp -d)"
trap 'if [ "${1:-}" != "--keep" ]; then rm -rf "$OUT"; fi' EXIT
mkdir -p "$OUT/runtime"

# The resources the launcher asks for, with the format arguments substituted the way `getString` does.
python3 - "$OUT" <<'PYRES'
import re, sys, glob
out = sys.argv[1]
strings = {}
for path in glob.glob("android/app/src/main/res/values/*.xml"):
    for m in re.finditer(r'<string name="([^"]+)">(.*?)</string>', open(path).read(), re.S):
        text = m.group(2).replace("\\'", "'").replace("\\n", "\n").replace("&amp;", "&")
        strings[m.group(1)] = text
with open(out + "/runtime/R.kt", "w") as f:
    f.write("package org.shrek2.launcher\n\nobject R {\n  object string {\n")
    for name in sorted(strings):
        f.write(f'    const val {name}: Int = {1000 + len(name)}\n')
    f.write("  }\n  object drawable { const val ic_launcher = 1 }\n  object xml { const val backup_rules = 2 }\n  object style { const val Theme_Shrek2 = 3 }\n}\n")
with open(out + "/runtime/strings.tsv", "w") as f:
    for name, text in strings.items():
        f.write(f"{1000 + len(name)}\t{text}\n")
print(f"resources: {len(strings)} strings")
PYRES

cat > "$OUT/runtime/stubs.txt" <<'STUB'
=== android.util
@Suppress("unused", "UNUSED_PARAMETER")
object Log {
  const val DEBUG = 3
  const val INFO = 4
  const val WARN = 5
  const val ERROR = 6
  private val lines = ArrayList<String>()
  fun d(tag: String, msg: String): Int = record("D", tag, msg)
  fun i(tag: String, msg: String): Int = record("I", tag, msg)
  fun w(tag: String, msg: String): Int = record("W", tag, msg)
  fun e(tag: String, msg: String): Int = record("E", tag, msg)
  fun e(tag: String, msg: String, t: Throwable?): Int = record("E", tag, "$msg: $t")
  fun println(priority: Int, tag: String, msg: String): Int = record("?", tag, msg)
  private fun record(level: String, tag: String, msg: String): Int {
    lines += "$level/$tag: $msg"
    return 0
  }
  fun dump() = lines
}
=== android.content
import harness.Strings
import harness.StubResolver
import harness.StubPackageManager
import harness.StubAssets
import android.content.pm.PackageManager
import android.content.res.AssetManager
import java.io.File

/** The parts of a Context the launcher touches: private storage, strings, the package version. */
@Suppress("unused", "UNUSED_PARAMETER")
open class Context {
  /** Set by the harness: a scratch directory that stands in for the app's private storage. */
  var rootDir: File = File("/tmp").resolve("shrek2-launcher-check")
  open val noBackupFilesDir: File get() = rootDir
  open val cacheDir: File get() = File(rootDir, "cache")
  open val filesDir: File get() = File(rootDir, "files")
  open val assets: AssetManager get() = StubAssets
  open val packageManager: PackageManager get() = StubPackageManager
  open val packageName: String get() = "org.shrek2.launcher"
  open val contentResolver: ContentResolver get() = StubResolver
  fun startActivity(intent: Intent) {}
  fun getString(id: Int): String = Strings.get(id)
  fun getString(id: Int, vararg args: Any?): String = Strings.format(Strings.get(id), args)
}
open class Intent {
  constructor(action: String)
  constructor(ctx: Context, cls: Class<*>)
  var type: String = ""
  var data: android.net.Uri? = null
  fun addFlags(flags: Int): Intent = this
  fun addCategory(category: String): Intent = this
  fun putExtra(name: String, value: String): Intent = this
  fun putExtra(name: String, value: Array<String>): Intent = this
  fun putExtra(name: String, value: android.os.Bundle?): Intent = this
  fun setData(uri: android.net.Uri): Intent = this
  companion object {
    const val ACTION_OPEN_DOCUMENT = "android.intent.action.OPEN_DOCUMENT"
    const val ACTION_OPEN_DOCUMENT_TREE = "android.intent.action.OPEN_DOCUMENT_TREE"
    const val CATEGORY_OPENABLE = "android.intent.category.OPENABLE"
    const val EXTRA_MIME_TYPES = "android.intent.extra.MIME_TYPES"
    const val EXTRA_TITLE = "android.intent.extra.TITLE"
    const val FLAG_GRANT_READ_URI_PERMISSION = 0x1
    fun createChooser(target: Intent, title: CharSequence?): Intent = target
  }
}
open class ContentResolver {
  /** Set by the harness: the document bytes (a null stand-in means "no such document"). */
  var document: ByteArray? = null
  /** When set, the provider refuses to return bytes past this offset -- a download that stops early. */
  var stopsAfter: Long = -1
  open fun openInputStream(uri: android.net.Uri): java.io.InputStream? {
    val bytes = document ?: return null
    return object : java.io.InputStream() {
      var at = 0L
      override fun read(): Int {
        if (stopsAfter >= 0 && at >= stopsAfter) return -1
        if (at >= bytes.size) return -1
        return bytes[(at++).toInt()].toInt() and 0xff
      }
      override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (stopsAfter >= 0 && at >= stopsAfter) return -1
        if (at >= bytes.size) return -1
        val n = minOf(len.toLong(), bytes.size - at, if (stopsAfter >= 0) stopsAfter - at else Long.MAX_VALUE).toInt()
        if (n <= 0) return -1
        System.arraycopy(bytes, at.toInt(), b, off, n)
        at += n
        return n
      }
      override fun skip(n: Long): Long {
        val step = minOf(n, bytes.size - at, if (stopsAfter >= 0) maxOf(0, stopsAfter - at) else Long.MAX_VALUE)
        at += step
        return step
      }
    }
  }
  open fun query(uri: android.net.Uri, projection: Array<String>?, selection: String?, args: Array<String>?, sort: String?): android.database.Cursor? = null
  open fun takePersistableUriPermission(uri: android.net.Uri, mode: Int) {}
}
=== android.database
@Suppress("unused")
interface Cursor : java.io.Closeable {
  fun moveToNext(): Boolean
  fun moveToFirst(): Boolean
  fun isNull(index: Int): Boolean
  fun getLong(index: Int): Long
  fun getInt(index: Int): Int
  fun getString(index: Int): String?
  fun getColumnIndex(name: String): Int
}
=== android.content.pm
@Suppress("unused", "UNUSED_PARAMETER")
open class PackageManager { open fun getPackageInfo(name: String, flags: Int): PackageInfo = PackageInfo() }
class PackageInfo { var versionName: String? = "0.1" }
=== android.content.res
@Suppress("unused", "UNUSED_PARAMETER")
abstract class AssetManager {
  abstract fun open(name: String): java.io.InputStream
  abstract fun list(path: String): Array<String>
}
=== android.net
@Suppress("unused")
class Uri {
  companion object { fun parse(s: String): Uri = Uri() }
}
=== android.os
@Suppress("unused", "UNUSED_PARAMETER")
class Bundle { fun getString(key: String): String? = null; fun putString(key: String, value: String) {} }
object Build { object VERSION { const val SDK_INT = 35 } }
object Looper { fun getMainLooper(): Any = Any(); fun myLooper(): Any? = getMainLooper() }
class ParcelFileDescriptor : java.io.Closeable { override fun close() {} }
=== android.provider
import android.net.Uri

@Suppress("unused", "UNUSED_PARAMETER")
object OpenableColumns { const val SIZE = "_size"; const val DISPLAY_NAME = "_display_name" }
object Settings
=== android.view
import android.content.Context

/**
 * A view stand-in that enforces the rules that crash a real device: a view can have one parent only
 * (`IllegalStateException`), and it must be attached to the window before it is drawn.
 */
@Suppress("unused", "UNUSED_PARAMETER", "UNUSED_VARIABLE")
open class View {
  var visibility: Int = 0
  var id: Int = 0
  var isEnabled: Boolean = true
  var parent: ViewGroup? = null
    private set
  var ctx: Context? = null
  var text: CharSequence? = null
  var textSize: Float = 0f
  var isChecked: Boolean = false
  var orientation: Int = 0
  private var click: ((View) -> Unit)? = null
  val children = ArrayList<View>()

  internal fun detach() { parent = null }

  fun attachTo(p: ViewGroup) {
    if (parent != null && parent !== p) {
      throw IllegalStateException("The specified child already has a parent. You must call removeView() on the child's parent first.")
    }
    parent = p
  }

  fun setOnClickListener(listener: (View) -> Unit) {
    click = listener
  }

  /** What tapping the control does; used by the harness. */
  fun performClick() {
    click?.invoke(this) ?: throw IllegalStateException("view $this has no click listener")
  }

  fun setPadding(l: Int, t: Int, r: Int, b: Int) {}
  fun post(action: Runnable): Boolean { action.run(); return true }
  fun <T : View> findViewById(id: Int): T {
    val found = find(id)
    @Suppress("UNCHECKED_CAST")
    return (found ?: throw IllegalStateException("no view with id $id")) as T
  }

  fun find(id: Int): View? {
    if (this.id == id) return this
    for (c in children) c.find(id)?.let { return it }
    return null
  }
  companion object { const val GONE = 8; const val VISIBLE = 0 }
}
open class ViewGroup(ctx: Context?) : View() {
  open class LayoutParams(val width: Int, val height: Int) {
    var topMargin = 0
    companion object { const val MATCH_PARENT = -1; const val WRAP_CONTENT = -2 }
  }
  fun addView(v: View) {
    addView(v, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
  }
  fun addView(v: View, params: LayoutParams) {
    // The rule the phone enforces, and the one the launcher broke.
    if (v.parent != null && v.parent !== this) {
      throw IllegalStateException("The specified child already has a parent. You must call removeView() on the child's parent first.")
    }
    if (v.parent === this) return
    v.attachTo(this)
    children += v
  }
  fun removeAllViews() { for (c in children) c.detach(); children.clear() }
  val childCount: Int get() = children.size
  val child: View get() = children.last()
}
object Gravity { const val CENTER_VERTICAL = 16; const val CENTER_HORIZONTAL = 1; const val TOP = 48 }
=== android.view.inputmethod
class InputConnection
=== android.widget
import harness.Strings
import android.content.Context
import android.view.View
import android.view.ViewGroup

@Suppress("unused", "UNUSED_PARAMETER", "UNUSED_VARIABLE")
open class TextView(ctx: Context?) : View() {
  private var checked: ((View, Boolean) -> Unit)? = null
  fun setOnCheckedChangeListener(l: (View, Boolean) -> Unit) { checked = l }
  fun toggle() { isChecked = !isChecked; checked?.invoke(this, isChecked) }
  fun setText(id: Int) { text = Strings.get(id) }
  fun setTextColor(color: Int) {}
}
open class Button(ctx: Context?) : TextView(ctx)
open class CheckBox(ctx: Context?) : TextView(ctx)
open class SeekBar(ctx: Context?) : View() {
  var progress: Int = 0
  var max: Int = 0
  private var listener: OnSeekBarChangeListener? = null
  fun setOnSeekBarChangeListener(l: OnSeekBarChangeListener) { listener = l }
  /** Drags the thumb to [value] and fires the callbacks in the order a finger does. */
  fun dragTo(value: Int) {
    progress = value
    listener?.onProgressChanged(this, value, true)
    listener?.onStartTrackingTouch(this)
    listener?.onStopTrackingTouch(this)
  }
  interface OnSeekBarChangeListener {
    fun onProgressChanged(bar: SeekBar, value: Int, fromUser: Boolean)
    fun onStartTrackingTouch(bar: SeekBar)
    fun onStopTrackingTouch(bar: SeekBar)
  }
}
open class ProgressBar(ctx: Context?, attrs: Any?, defStyle: Int) : View() {
  var progress: Int = 0
  var max: Int = 0
  var isIndeterminate: Boolean = false
}
open class LinearLayout(ctx: Context?) : ViewGroup(ctx) {
  constructor(ctx: Context?, attrs: Any?, defStyle: Int) : this(ctx)
  fun setGravity(g: Int) {}
  class LayoutParams : ViewGroup.LayoutParams {
    constructor(width: Int, height: Int) : super(width, height)
  }
  companion object { const val VERTICAL = 1; const val HORIZONTAL = 0 }
}
open class ScrollView(ctx: Context?) : ViewGroup(ctx)
=== android.app
import harness.Strings
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View

@Suppress("unused", "UNUSED_PARAMETER")
open class Activity : Context() {
  var finished = false
  var contentView: View? = null
    private set
  val started = ArrayList<Intent>()
  open fun onCreate(savedInstanceState: Bundle?) {}
  open fun onResume() {}
  open fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {}
  open fun startActivityForResult(intent: Intent, requestCode: Int) {
    pendingIntent = intent
    pendingRequest = requestCode
  }
  var pendingIntent: Intent? = null
    private set
  var pendingRequest: Int = -1
    private set
  open fun runOnUiThread(action: Runnable) { action.run() }
  fun setContentView(view: View) { contentView = view }
  fun finish() { finished = true }
  fun <T : View> findViewById(id: Int): T {
    @Suppress("UNCHECKED_CAST")
    return (contentView?.find(id) ?: throw IllegalStateException("no view with id $id")) as T
  }
  companion object { const val RESULT_OK = -1; const val RESULT_CANCELED = 0 }
}
=== android
@Suppress("unused")
object R {
  object attr { const val progressBarStyleHorizontal = 1 }
}
=== org.shrek2.launcher
/** The game screen needs a surface and GL; the launcher only starts it. */
@Suppress("unused")
open class GameActivity : android.app.Activity()
=== androidx.appcompat.app
@Suppress("unused")
open class AppCompatActivity : android.app.Activity()
=== harness
/**
 * An `AssetManager` over a directory: the APK's `assets/` for the purposes of this harness. The bundled
 * game is written there by `tools/pack-game.mjs`, so unpacking it is the real code path over real bytes.
 */
class DirAssets : android.content.res.AssetManager() {
  var root: java.io.File? = null
  private fun file(path: String): java.io.File {
    val base = root ?: throw java.io.FileNotFoundException(path)
    val f = java.io.File(base, path)
    if (!f.isFile) throw java.io.FileNotFoundException(path)
    return f
  }
  override fun open(name: String): java.io.InputStream = file(name).inputStream()
  override fun list(path: String): Array<String> {
    val base = root ?: return emptyArray()
    val dir = if (path.isEmpty()) base else java.io.File(base, path)
    return dir.list()?.sorted()?.toTypedArray() ?: emptyArray()
  }
}
=== org.shrek2.launcher
/**
 * Stand-in for the real `InstallFiles`, which is a JNI facade (`System.loadLibrary("shrek2")`) and cannot
 * load on a JVM. The layout it describes is the same; what it checks is whether the launcher asks for it
 * correctly at start-up.
 */
@Suppress("unused", "UNUSED_PARAMETER")
object InstallFiles {
  const val GAME_EXE = "Game/Shrek 2.exe"
  fun installDir(context: android.content.Context): java.io.File = java.io.File(context.noBackupFilesDir, "install")
  fun cacheDir(context: android.content.Context): java.io.File = java.io.File(context.noBackupFilesDir, "cache")
  fun installed(context: android.content.Context): Boolean = java.io.File(installDir(context), GAME_EXE).isFile
  fun compiled(context: android.content.Context): Boolean = java.io.File(cacheDir(context), "game.sk2a").isFile
  fun unpackImage(context: android.content.Context): Boolean = false
  fun prepare(context: android.content.Context): Boolean {
    installDir(context).mkdirs()
    cacheDir(context).mkdirs()
    return installed(context)
  }
  fun imageBytes(context: android.content.Context): Long =
    java.io.File(cacheDir(context), "game.sk2a").let { if (it.isFile) it.length() else 0L }
}
=== harness
import java.io.File

/** `getString` with the resource table this script generated from res/values/strings.xml. */
object Strings {
  private val table = HashMap<Int, String>()
  init {
    val file = File("/tmp/shrek2-launcher-strings.tsv")
    if (file.isFile) {
      for (line in file.readLines()) {
        val tab = line.indexOf('\t')
        if (tab > 0) table[line.substring(0, tab).toInt()] = line.substring(tab + 1)
      }
    }
  }
  fun get(id: Int): String = table[id] ?: throw IllegalStateException("no string resource $id")
  /** `String.format` with the placeholders the XML uses (`%1$s`, `%1$d`, `%%`). */
  fun format(fmt: String, args: Array<out Any?>): String = String.format(fmt, *args)
}

object StubPackageManager : android.content.pm.PackageManager()
object StubAssets : android.content.res.AssetManager() {
  /** Set by the harness: serve `assets/` from this directory. */
  var root: java.io.File? = null
  private fun file(path: String): java.io.File {
    val base = root ?: throw java.io.FileNotFoundException(path)
    val f = java.io.File(base, path)
    if (!f.isFile) throw java.io.FileNotFoundException(path)
    return f
  }
  override fun open(name: String): java.io.InputStream = file(name).inputStream()
  override fun list(path: String): Array<String> {
    val base = root ?: return emptyArray()
    val dir = if (path.isEmpty()) base else java.io.File(base, path)
    return dir.list()?.sorted()?.toTypedArray() ?: emptyArray()
  }
}
object StubResolver : android.content.ContentResolver() {
  /** The provider's answer to a SIZE query: the length of the document it is serving. */
  override fun query(
    uri: android.net.Uri,
    projection: Array<String>?,
    selection: String?,
    args: Array<String>?,
    sort: String?,
  ): android.database.Cursor? {
    val size = document?.size?.toLong() ?: return null
    return object : android.database.Cursor {
      var first = true
      override fun moveToFirst(): Boolean = first.also { first = false }
      override fun moveToNext(): Boolean = false
      override fun isNull(index: Int): Boolean = false
      override fun getLong(index: Int): Long = size
      override fun getInt(index: Int): Int = size.toInt()
      override fun getString(index: Int): String? = null
      override fun getColumnIndex(name: String): Int = 0
      override fun close() {}
    }
  }
}
STUB

python3 - "$OUT" <<'PYSPLIT'
import sys, re, os
out = sys.argv[1]
text = open(out + "/runtime/stubs.txt").read()
# One file per chunk: a package may appear twice (a framework stub and a project stand-in).
for n, chunk in enumerate(re.split(r"^=== ", text, flags=re.M)[1:]):
    pkg, body = chunk.split("\n", 1)
    pkg = pkg.strip()
    path = os.path.join(out, "runtime", f"{n:02d}_" + pkg.replace(".", "_") + ".kt")
    open(path, "w").write(f'@file:Suppress("unused", "UNUSED_PARAMETER")\npackage {pkg}\n\n{body}')
print("stubs ready")
PYSPLIT

cp "$OUT/runtime/strings.tsv" /tmp/shrek2-launcher-strings.tsv

# The harness: open the launcher the way the phone does, then use every control it built.
cat > "$OUT/runtime/Harness.kt" <<'HARNESS'
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.SeekBar
import org.shrek2.launcher.LauncherActivity
import org.shrek2.launcher.Settings
import harness.StubAssets
import harness.Strings
import harness.StubResolver
import java.io.File

private var failures = 0

private fun step(what: String, block: () -> Unit) {
  try {
    block()
    println("ok: $what")
  } catch (e: Throwable) {
    failures++
    println("FAILED: $what -- ${e::class.java.simpleName}: ${e.message}")
    e.stackTrace.take(6).forEach { println("        at $it") }
  }
}

fun main(args: Array<String>) {
  // The scratch root (the app's private storage) comes from a property; args[0] is a disc image and
  // args[1] a packed assets directory, either of which may be empty.
  val root = File(System.getProperty("shrek2.root") ?: "/tmp/shrek2-launcher-check")
  root.deleteRecursively()
  root.mkdirs()

  lateinit var activity: LauncherActivity

  // 1. The start-up path: exactly what happens when the icon is tapped.
  step("LauncherActivity.onCreate + onResume") {
    activity = LauncherActivity()
    activity.rootDir = root
    activity.onCreate(null)
    activity.onResume()
  }
  if (failures > 0) {
    println("FAILED: the launcher does not survive its own start-up ($failures problems)")
    kotlin.system.exitProcess(1)
  }

  // 2. A registry was written on the first run, with the values the game reads.
  step("the first start writes registry.txt") {
    val reg = File(root, "registry.txt")
    check(reg.isFile) { "no ${reg.path}" }
    val text = reg.readText()
    check(text.contains("\tresolution\t")) { "no resolution value: ${text.take(200)}" }
    check(text.contains("\tgp0_0\t")) { "no gamepad bindings" }
  }

  // 3. Every control the screen built has to be reachable and safe to use.
  step("tapping the resolution button cycles and is saved") {
    val button = activity.findViewById<Button>(0x7f000001)
    val before = button.text.toString()
    button.performClick()
    val after = button.text.toString()
    check(after != before) { "the label did not change ($before)" }
    val text = File(root, "registry.txt").readText()
    check(Settings.RESOLUTIONS.withIndex().any { (i, label) -> after == label && text.contains("\tresolution\tdword\t$i") }) {
      "the new resolution was not written: $after"
    }
  }

  step("each switch can be toggled") {
    var seen = 0
    fun walk(v: View) {
      if (v is CheckBox) { seen++; v.toggle() }
      for (c in v.children) walk(c)
    }
    activity.contentView?.let { walk(it) }
    check(seen >= 3) { "expected shadows, anti-aliasing and clipping, found $seen switches" }
    val text = File(root, "registry.txt").readText()
    check(text.contains("\toptions\tdword\t")) { "options were not rewritten" }
  }

  step("dragging the distance slider saves the value") {
    val bar = activity.findViewById<SeekBar>(0x7f000002)
    bar.dragTo(40)
    check(File(root, "registry.txt").readText().contains("\tdistance\tdword\t40")) { "distance not saved" }
  }

  step("the install button asks for a document (an ISO), not a folder") {
    val install = activity.contentView!!.let { root ->
      var found: Button? = null
      fun walk(v: View) { if (v is Button && v.text?.toString() == Strings.get(1000 + "install_title".length)) found = v; for (c in v.children) walk(c) }
      walk(root)
      found ?: throw IllegalStateException("no install button")
    }
    install.performClick()
    val intent = activity.pendingIntent ?: throw IllegalStateException("no intent was started")
    check(intent.type == "*/*") { "the picker does not accept any file (type=${intent.type})" }
  }

  // 4. The install path, driven through the same `content://` interface the phone uses. A disc image is
  //    picked, the installer reads it *from the document* (no copy into the cache) and writes the game
  //    files. The image comes from the corpus the installer test generates, so this covers the wiring:
  //    document -> installer -> install directory.
  val iso = File(args.getOrNull(0)?.takeIf { it.isNotEmpty() } ?: "/tmp/shrek2-launcher-disc.iso")
  if (!iso.isFile) {
    println("SKIP  the install path (no disc image at ${iso.path}; tools/installer-test.sh provides one)")
  } else {
  step("an ISO picked from the document is installed without being copied") {
    check(iso.isFile) { "no disc image at ${iso.path}" }
    check(!File(root, "cache/disc.iso").isFile) {
      "the launcher copied the image into the cache (that copy is what truncated a 548 MB disc)"
    }
    StubResolver.document = iso.readBytes()
    StubResolver.stopsAfter = -1
    check(activity.installForTest(android.net.Uri.parse("content://test/disc.iso")) == null) { "the install failed" }
    val exe = File(root, "install/Game/Shrek 2.exe")
    check(exe.isFile) { "the game was not installed from the document" }
    check(File(root, "install/Game/Chars/ogre.tex").isFile) { "the cabinet was not unpacked" }
  }

  step("a document that stops early is reported as incomplete, by name") {
    val target = File(root, "install").apply { deleteRecursively(); mkdirs() }
    StubResolver.document = iso.readBytes()
    // The provider stops handing out bytes well inside the image: the shape of what the phone hit, where a
    // 548 MB disc reached the installer as a 20 MB file. (The corpus is small, so the cut is a fraction of
    // it -- what matters is that it lands inside a member the install has to read.)
    StubResolver.stopsAfter = iso.length() / 3
    val message = try {
      activity.installForTest(android.net.Uri.parse("content://test/disc.iso"))
    } finally {
      StubResolver.stopsAfter = -1
    }
    val m = message ?: throw IllegalStateException("the short document was accepted")
    println("     reported: ${m.take(120)}")
    check(m.contains("incomplete") || m.contains("truncated")) { "unclear message: $m" }
    check(!m.contains("outside source")) { "raw bounds failure: $m" }
    check(!File(target, "Game/Shrek 2.exe").isFile) { "a short document produced an install" }
    target.deleteRecursively()
  }
  }

  // 5. The game built into the APK: nothing is installed, the APK carries one, the launcher unpacks it on
  //    its own and "Play" becomes available -- the flow a player gets when they install the APK.
  val assets = args.getOrNull(1)?.takeIf { it.isNotEmpty() }?.let { File(it) }
  if (assets == null || !assets.isDirectory) {
    println("SKIP  the bundled game (no packed assets directory given)")
  } else {
    val fresh = File(root, "bundled").apply { deleteRecursively(); mkdirs() }
    step("the game inside the APK is unpacked on the first start") {
      val ctx = LauncherActivity()
      ctx.rootDir = fresh
      StubAssets.root = assets
      ctx.onCreate(null)
      ctx.onResume()                    // this is what triggers the unpack
      // It runs on a worker thread: wait for it the way the player waits -- by looking at the screen.
      var waited = 0
      while (!org.shrek2.launcher.InstallFiles.installed(ctx) && waited < 20_000) {
        Thread.sleep(50)
        waited += 50
      }
      check(org.shrek2.launcher.InstallFiles.installed(ctx)) { "the packaged game was not unpacked" }
      val exe = File(fresh, "install/Game/Shrek 2.exe")
      check(exe.isFile) { "no ${exe.path}" }
      check(exe.length() > 0) { "the executable is empty" }
      ctx.onResume()                    // a second start must not unpack again
      check(File(fresh, "install/.bundled").isFile) { "no unpack stamp" }
    }
  }

  println(if (failures == 0) "ok: the launcher starts and works (no crash paths found)" else "FAILED ($failures problems)")
  if (failures != 0) kotlin.system.exitProcess(1)
}
HARNESS

SOURCES=$(find android/app/src/main/java/org/shrek2/launcher/install -name '*.kt' | sort)
SOURCES="$SOURCES android/app/src/main/java/org/shrek2/launcher/LauncherActivity.kt"
SOURCES="$SOURCES android/app/src/main/java/org/shrek2/launcher/Settings.kt"
SOURCES="$SOURCES android/app/src/main/java/org/shrek2/launcher/ContentSource.kt"
SOURCES="$SOURCES android/app/src/main/java/org/shrek2/launcher/BundledGame.kt"
SOURCES="$SOURCES android/app/src/main/java/org/shrek2/launcher/Registry.kt"
# `InstallFiles.kt` is left out on purpose: it is a JNI facade (`System.loadLibrary`), replaced by the
# stand-in above. Everything else on the start-up path is the real code.

echo "== compiling the launcher with the runtime stand-in =="
# shellcheck disable=SC2086
"$KOTLINC" -nowarn -d "$OUT/launcher.jar" "$OUT"/runtime/*.kt $SOURCES 2>&1 |
  grep -vE '^(warning|WARNING):' || true
[ -f "$OUT/launcher.jar" ] || { echo "the launcher does not compile"; exit 1; }

echo "== running the launcher's start-up and its controls =="
STDLIB="$(dirname "$(readlink -f "$KOTLINC")")/../lib/kotlin-stdlib.jar"
[ -f "$STDLIB" ] || STDLIB=""
# The harness takes a disc image and a packed assets directory; the scratch root is a property so the
# argument order stays readable. (`"$@"` is the script's own arguments -- `--keep` included -- so it is not
# forwarded; the harness reads only what is passed here.)
java -Dshrek2.root="${SHREK2_HARNESS_ROOT:-/tmp/shrek2-launcher-check}" \
  -cp "$OUT/launcher.jar${STDLIB:+:$STDLIB}" HarnessKt "${SHREK2_HARNESS_ISO:-}" "${SHREK2_HARNESS_ASSETS:-}"

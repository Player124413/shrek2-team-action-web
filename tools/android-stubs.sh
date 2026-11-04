#!/usr/bin/env bash
# Compile the launcher's Kotlin against Android API stubs.
#
# There is no Android SDK on a plain Linux box, and downloading one is tens of gigabytes -- too much for
# a quick "does this still type-check" check while editing. The launcher touches a handful of framework
# classes, so this script writes minimal stubs for exactly those and lets kotlinc type-check the real
# sources against them. It catches the mistakes that matter here: a renamed method, a wrong parameter,
# a string resource that does not exist, a symbol the installer no longer has.
#
# It is NOT a substitute for the Gradle build (that one compiles against the real SDK, runs aapt2 and
# packages the APK); `tools/android-check.sh` and the workflow still do that.
#
# Usage: tools/android-stubs.sh [--keep]
#   needs kotlinc on PATH, or KOTLINC=/path/to/kotlinc
set -euo pipefail

cd "$(dirname "$0")/.."
KOTLINC="${KOTLINC:-kotlinc}"
command -v "$KOTLINC" > /dev/null || { echo "kotlinc not found: set KOTLINC=/path/to/kotlinc" >&2; exit 1; }

OUT="$(mktemp -d)"
trap 'if [ "${1:-}" != "--keep" ]; then rm -rf "$OUT"; fi' EXIT

mkdir -p "$OUT/stubs"
cat > "$OUT/stubs.txt" <<'STUB'
// Minimal shapes of the Android classes the launcher uses. Signatures follow the SDK; only what is
// used is declared, and every body throws, because nothing here is ever executed.
=== android.app
import android.content.Context
import android.content.Intent
import android.content.ContentResolver
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View

@Suppress("unused", "UNUSED_PARAMETER")
open class Activity : Context() {
  open fun onCreate(savedInstanceState: Bundle?) {}
  open fun onResume() {}
  open fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {}
  open fun startActivityForResult(intent: Intent, requestCode: Int) {}
  open fun runOnUiThread(action: Runnable) {}
  fun setContentView(view: View) {}
  fun finish() {}
  fun <T : View> findViewById(id: Int): T = throw Error()
  companion object { const val RESULT_OK = -1 }
}
=== android.content
import android.content.pm.PackageManager
import android.content.res.AssetManager

@Suppress("unused", "UNUSED_PARAMETER")
open class Context {
  open val assets: AssetManager get() = throw Error()
  open val cacheDir: java.io.File get() = throw Error()
  open val noBackupFilesDir: java.io.File get() = throw Error()
  open val packageManager: PackageManager get() = throw Error()
  open val packageName: String get() = throw Error()
  open val contentResolver: ContentResolver get() = throw Error()
  fun startActivity(intent: Intent) {}
  fun getString(id: Int): String = throw Error()
  fun getString(id: Int, vararg args: Any?): String = throw Error()
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
    fun createChooser(target: Intent, title: CharSequence?): Intent = throw Error()
  }
}
abstract class ContentResolver {
  abstract fun openInputStream(uri: android.net.Uri): java.io.InputStream?
  abstract fun openOutputStream(uri: android.net.Uri): java.io.OutputStream?
  abstract fun openFileDescriptor(uri: android.net.Uri, mode: String): android.os.ParcelFileDescriptor?
  abstract fun query(uri: android.net.Uri, projection: Array<String>?, selection: String?, args: Array<String>?, sort: String?): android.database.Cursor?
  abstract fun takePersistableUriPermission(uri: android.net.Uri, mode: Int)
}
class IntentFilter
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
=== android
@Suppress("unused")
object R {
  object attr { const val progressBarStyleHorizontal = 1 }
}
=== android.content.pm
@Suppress("unused")
class PackageManager { fun getPackageInfo(name: String, flags: Int): PackageInfo = throw Error() }
class PackageInfo { var versionName: String? = null }
=== android.content.res
@Suppress("unused")
abstract class AssetManager {
  abstract fun open(name: String): java.io.InputStream
  abstract fun list(path: String): Array<String>
}
=== android.net
@Suppress("unused")
class Uri {
  companion object { fun parse(s: String): Uri = throw Error() }
}
=== android.os
@Suppress("unused", "UNUSED_PARAMETER")
class Bundle { fun getString(key: String): String? = throw Error(); fun putString(key: String, value: String) {} }
object Build { object VERSION { const val SDK_INT = 35 } }
class Looper
class ParcelFileDescriptor : java.io.Closeable { override fun close() {} }
=== android.provider
import android.net.Uri

@Suppress("unused", "UNUSED_PARAMETER")
object OpenableColumns { const val SIZE = "_size"; const val DISPLAY_NAME = "_display_name" }
object Settings
class DocumentsContract {
  companion object {
    object Document {
      const val COLUMN_DOCUMENT_ID = "document_id"
      const val COLUMN_DISPLAY_NAME = "_display_name"
      const val COLUMN_MIME_TYPE = "mime_type"
      const val MIME_TYPE_DIR = "vnd.android.document/directory"
    }
    fun getTreeDocumentId(uri: Uri): String = throw Error()
    fun buildChildDocumentsUriUsingTree(uri: Uri, id: String): Uri = throw Error()
    fun buildDocumentUriUsingTree(uri: Uri, id: String): Uri = throw Error()
  }
}
=== android.view
@Suppress("unused", "UNUSED_PARAMETER", "UNUSED_VARIABLE")
open class View {
  var visibility: Int = 0
  var id: Int = 0
  var isEnabled: Boolean = true
  fun setOnClickListener(listener: (View) -> Unit) {}
  fun setPadding(l: Int, t: Int, r: Int, b: Int) {}
  fun post(action: Runnable): Boolean = throw Error()
  fun <T : View> findViewById(id: Int): T = throw Error()
  companion object { const val GONE = 8; const val VISIBLE = 0 }
}
open class ViewGroup(ctx: android.content.Context?) : View() {
  open class LayoutParams(width: Int, height: Int) {
    var topMargin = 0
    companion object { const val MATCH_PARENT = -1; const val WRAP_CONTENT = -2 }
  }
  fun addView(v: View) {}
  fun addView(v: View, params: LayoutParams) {}
  open val childCount: Int get() = 0
  open fun getChildAt(i: Int): View = throw Error()
  companion object { const val MATCH_PARENT = -1; const val WRAP_CONTENT = -2 }
}
object Gravity { const val CENTER_VERTICAL = 16; const val CENTER_HORIZONTAL = 1 }
=== android.view.inputmethod
class InputConnection
=== android.widget
import android.content.Context
import android.view.View
import android.view.ViewGroup

@Suppress("unused", "UNUSED_PARAMETER", "UNUSED_VARIABLE")
open class TextView(ctx: Context?) : View() {
  var text: CharSequence? = null
  var textSize: Float = 0f
  fun setText(id: Int) {}
  fun setTextColor(color: Int) {}
}
open class Button(ctx: Context?) : TextView(ctx)
open class CheckBox(ctx: Context?) : TextView(ctx) {
  var isChecked: Boolean = false
  fun setOnCheckedChangeListener(l: (CheckBox, Boolean) -> Unit) {}
}
open class SeekBar(ctx: Context?) : View() {
  var max: Int = 0
  var progress: Int = 0
  fun setOnSeekBarChangeListener(l: OnSeekBarChangeListener) {}
  interface OnSeekBarChangeListener {
    fun onProgressChanged(bar: SeekBar, value: Int, fromUser: Boolean)
    fun onStartTrackingTouch(bar: SeekBar)
    fun onStopTrackingTouch(bar: SeekBar)
  }
}
open class ProgressBar(ctx: Context?, attrs: Any?, defStyle: Int) : View() {
  var max: Int = 0
  var progress: Int = 0
  var isIndeterminate: Boolean = false
}
open class LinearLayout(ctx: Context?) : ViewGroup(ctx) {
  constructor(ctx: Context?, attrs: Any?, defStyle: Int) : this(ctx)
  var orientation: Int = 0
  class LayoutParams : ViewGroup.LayoutParams {
    constructor(width: Int, height: Int) : super(width, height)
  }
  fun setGravity(g: Int) {}
  companion object { const val VERTICAL = 1; const val HORIZONTAL = 0 }
}
open class ScrollView(ctx: Context?) : ViewGroup(ctx)
=== org.shrek2.launcher
@Suppress("unused")
open class GameActivity : android.app.Activity()
=== androidx.appcompat.app
@Suppress("unused")
open class AppCompatActivity : android.app.Activity()
STUB

# Kotlin has no package blocks: one file per package, split on the `=== <package>` markers.
python3 - "$OUT" <<'PYSPLIT'
import sys, re, os
out = sys.argv[1]
text = open(out + "/stubs.txt").read()
files = 0
for chunk in re.split(r"^=== ", text, flags=re.M)[1:]:
    pkg, body = chunk.split("\n", 1)
    pkg = pkg.strip()
    path = os.path.join(out, "stubs", pkg.replace(".", "_") + ".kt")
    open(path, "w").write(f"@file:Suppress(\"unused\", \"UNUSED_PARAMETER\")\npackage {pkg}\n\n{body}")
    files += 1
print(f"stubs: {files} packages")
PYSPLIT

# The resources: parse values/*.xml for string names, so a missing string resource fails here too.
python3 - "$OUT" <<'PY'
import re, sys, glob
out = sys.argv[1]
names = []
for path in glob.glob("android/app/src/main/res/values/*.xml"):
    names += re.findall(r'<string name="([^"]+)"', open(path).read())
with open(out + "/stubs/R.kt", "w") as f:
    f.write("package org.shrek2.launcher\n\nobject R {\n  object string {\n")
    for n in sorted(set(names)):
        f.write(f"    const val {n}: Int = {1000 + len(n)}\n")
    f.write("  }\n}\n")
print(f"resources: {len(set(names))} strings")
PY

# The launcher screen and the installer: everything a player interacts with before the game starts. The
# game activity and the touch overlay draw with Canvas/MotionEvent/GLSurfaceView and are covered by the
# Gradle build instead -- stubbing a whole graphics API here would test the stubs, not the code.
SOURCES=$(find android/app/src/main/java/org/shrek2/launcher/install -name '*.kt' | sort)
SOURCES="$SOURCES android/app/src/main/java/org/shrek2/launcher/LauncherActivity.kt"
SOURCES="$SOURCES android/app/src/main/java/org/shrek2/launcher/Settings.kt"
SOURCES="$SOURCES android/app/src/main/java/org/shrek2/launcher/Registry.kt"
SOURCES="$SOURCES android/app/src/main/java/org/shrek2/launcher/InstallFiles.kt"
echo "kotlin: $(echo "$SOURCES" | wc -w) files"
# shellcheck disable=SC2086
"$KOTLINC" -nowarn -d "$OUT/check.jar" "$OUT"/stubs/*.kt $SOURCES 2>&1 |
  grep -vE '^(warning|WARNING):' || true
[ -f "$OUT/check.jar" ] || exit 1
echo "ok: the launcher type-checks against the Android stubs"

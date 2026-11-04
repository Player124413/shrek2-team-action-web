package org.shrek2.launcher

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.view.MotionEvent
import android.view.View
import org.json.JSONObject
import java.io.File

private const val VK_ESCAPE = NativeInput.VK_ESCAPE
private const val VK_RETURN = NativeInput.VK_RETURN
private const val VK_SPACE = NativeInput.VK_SPACE
private const val VK_SHIFT = NativeInput.VK_SHIFT
private const val VK_LEFT = NativeInput.VK_LEFT
private const val VK_UP = NativeInput.VK_UP
private const val VK_RIGHT = NativeInput.VK_RIGHT
private const val VK_DOWN = NativeInput.VK_DOWN

/**
 * The on-screen controller: a virtual pad, a d-pad and a few free buttons, each emitting a *Windows
 * virtual-key* code, exactly as if a keyboard had sent it.
 *
 * Why keys and not a virtual gamepad: the game is a 2004 Windows title whose menus and control
 * remapping screens read the keyboard. Emitting VK codes (which the native side turns into PC set-1
 * scancodes) means the overlay goes through the game's own binding UI, and a Bluetooth keyboard,
 * a real pad and the touch controls all arrive the same way.
 *
 * Bindings are per player and persist as JSON in the app's private storage:
 * `{ "A": {"vk": 32, "label": "SPACE"}, ... }` -- rewritten by the launcher's binding screen, which
 * shares this file.
 */
@SuppressLint("ViewConstructor")
class TouchOverlayView(context: Context) : View(context) {

  /** Called on the UI thread: (virtual-key code, 0 = up / 1 = down / 2 = repeat). */
  var onKey: ((Int, Int) -> Unit)? = null
  var onMouseMove: ((Float, Float) -> Unit)? = null
  var onMouseButton: ((Int, Int) -> Unit)? = null
  var onPad: ((Int, Int, Float, Float) -> Unit)? = null

  /** One on-screen control: a circle that emits `vk` while a finger is inside it. */
  private class Control(
    val id: String,
    /** Centre in fractions of the view size (0..1), so the layout scales with the screen. */
    val cx: Float,
    val cy: Float,
    val radius: Float,
    var vk: Int,
  ) {
    var pointer = -1  // active pointer id, -1 when idle
    val touch = RectF()
  }

  private val controls = mutableListOf<Control>()
  private val dpad = Control("DPAD", 0f, 0f, 0f, 0)
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE
    textAlign = Paint.Align.CENTER
    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
  }

  /** Menu button (Escape), always present; the numeric keys double as camera controls. */
  private val defaults = listOf(
    Control("A", 0.90f, 0.80f, 0.075f, VK_SPACE),
    Control("B", 0.79f, 0.90f, 0.065f, VK_RETURN),
    Control("C", 0.96f, 0.60f, 0.055f, VK_SHIFT),
    Control("MENU", 0.04f, 0.10f, 0.05f, VK_ESCAPE),
    Control("CAM", 0.07f, 0.90f, 0.045f, 'C'.code),
  )

  init {
    controls += defaults
    loadBindings()
    // The overlay must not steal focus from the surface: the game's own keyboard handling keeps
    // working while the pad is on screen.
    isFocusable = false
    isClickable = false
  }

  // ---- Bindings --------------------------------------------------------------------------------

  private fun bindingFile(): File = File(context.filesDir, "touch-bindings.json")

  fun loadBindings() {
    val file = bindingFile()
    if (!file.exists()) return
    runCatching {
      val json = JSONObject(file.readText())
      for (c in controls) {
        json.optJSONObject(c.id)?.let { c.vk = it.optInt("vk", c.vk) }
      }
    }
  }

  fun saveBindings() {
    val json = JSONObject()
    for (c in controls) json.put(c.id, JSONObject().put("vk", c.vk))
    bindingFile().writeText(json.toString())
  }

  /** Rebinds a control (used by the launcher's settings screen). */
  fun bind(id: String, vk: Int) {
    controls.find { it.id == id }?.vk = vk
    saveBindings()
  }

  // ---- Layout ----------------------------------------------------------------------------------

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    val unit = minOf(w, h).toFloat()
    for (c in controls) {
      c.touch.set(c.cx * w - unit * c.radius, c.cy * h - unit * c.radius, c.cx * w + unit * c.radius, c.cy * h + unit * c.radius)
    }
    // Left thumb: an eight-way d-pad, laid out as two overlapping rings (up/down and left/right) so
    // diagonals are reachable without lifting the finger.
    dpad.touch.set(0f, 0f, unit * 0.55f, unit * 0.55f)
    val density = resources.displayMetrics.density
    text.textSize = 14f * density
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    paint.style = Paint.Style.FILL
    for (c in controls) {
      paint.color = if (c.pointer >= 0) 0x88FFD54F.toInt() else 0x44FFFFFF
      canvas.drawOval(c.touch, paint)
      paint.style = Paint.Style.STROKE
      paint.color = 0x99FFFFFF.toInt()
      paint.strokeWidth = 2f * resources.displayMetrics.density
      canvas.drawOval(c.touch, paint)
      paint.style = Paint.Style.FILL
      canvas.drawText(NativeInput.keyLabel(c.vk), c.touch.centerX(), c.touch.centerY() + text.textSize / 3, text)
    }
    drawDpad(canvas)
  }

  private fun drawDpad(canvas: Canvas) {
    val r = dpad.touch.width() / 2f
    val cx = dpad.touch.centerX()
    val cy = dpad.touch.centerY()
    paint.style = Paint.Style.FILL
    paint.color = 0x33FFFFFF
    canvas.drawCircle(cx, cy, r, paint)
    paint.style = Paint.Style.STROKE
    paint.color = 0x99FFFFFF.toInt()
    paint.strokeWidth = 2f * resources.displayMetrics.density
    canvas.drawCircle(cx, cy, r * 0.75f, paint)
    // Highlight the direction currently held (the d-pad emits arrow keys).
    val held = dpadDirection[dpad.pointer]
    if (dpad.pointer >= 0 && held != null) {
      paint.style = Paint.Style.FILL
      paint.color = 0x88FFD54F.toInt()
      canvas.drawCircle(cx + held.first * r * 0.55f, cy + held.second * r * 0.55f, r * 0.22f, paint)
    }
  }

  // ---- Input -----------------------------------------------------------------------------------

  /** Direction emitted by each active d-pad pointer, so a diagonal can hold two arrow keys. */
  private val dpadDirection = mutableMapOf<Int, Pair<Float, Float>>()
  private val dpadHeld = mutableMapOf<Int, Int>()  // pointer id -> vk currently down

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    // The overlay forwards every touch to the game as a mouse when the finger is not on a control:
    // that is how the menus (which are mouse-driven) stay usable without a mouse.
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = event.x
        downY = event.y
        downAt = event.eventTime
        dragged = false
        lastX = event.x
        lastY = event.y
        route(event)
      }
      MotionEvent.ACTION_MOVE -> {
        if (event.pointerCount == 1 && !onControl(event.x, event.y)) {
          // A finger that leaves its origin drags the game's pointer (the menus are mouse-driven).
          if (kotlin.math.hypot(event.x - downX, event.y - downY) > resources.displayMetrics.density * 12) dragged = true
          if (dragged) onMouseMove?.invoke(event.x - lastX, event.y - lastY)
          lastX = event.x
          lastY = event.y
        }
        route(event)
      }
      MotionEvent.ACTION_UP -> {
        // A tap in empty space is a left click -- that is how the game's menus are navigated.
        val tapped = !dragged && event.eventTime - downAt < 400 && !onControl(event.x, event.y)
        route(event)
        if (tapped) {
          onMouseButton?.invoke(0, 1)
          onMouseButton?.invoke(0, 0)
        }
      }
      MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_POINTER_UP -> route(event)
      MotionEvent.ACTION_CANCEL -> releaseAll()
    }
    invalidate()
    return true
  }

  private var lastX = 0f
  private var lastY = 0f
  /** Where and when the primary finger went down, to tell a tap (a click) from a drag (a look). */
  private var downX = 0f
  private var downY = 0f
  private var downAt = 0L
  private var dragged = false

  private fun route(event: MotionEvent) {
    val upPointer = event.actionIndex
    val lifting = event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_POINTER_UP
    for (i in 0 until event.pointerCount) {
      val id = event.getPointerId(i)
      val x = event.getX(i)
      val y = event.getY(i)
      val up = lifting && i == upPointer
      if (dpad.touch.contains(x, y) || dpadHeld[id] != null) {
        handleDpad(id, x, y, up)
        continue
      }
      val hit = controls.find { it.touch.contains(x, y) }
      if (hit != null) press(hit, id, up)
    }
  }

  private fun onControl(x: Float, y: Float): Boolean = dpad.touch.contains(x, y) || controls.any { it.touch.contains(x, y) }

  private fun press(c: Control, pointer: Int, up: Boolean) {
    if (up) {
      if (c.pointer == pointer) {
        c.pointer = -1
        onKey?.invoke(c.vk, NativeInput.ACTION_UP)
      }
      return
    }
    if (c.pointer < 0) {
      c.pointer = pointer
      onKey?.invoke(c.vk, NativeInput.ACTION_DOWN)
    }
  }

  private fun handleDpad(pointer: Int, x: Float, y: Float, up: Boolean) {
    val cx = dpad.touch.centerX()
    val cy = dpad.touch.centerY()
    val dx = (x - cx) / (dpad.touch.width() / 2f)
    val dy = (y - cy) / (dpad.touch.height() / 2f)
    val dead = 0.25f
    val vk = when {
      up -> 0
      kotlin.math.abs(dx) < dead && kotlin.math.abs(dy) < dead -> 0
      kotlin.math.abs(dx) > kotlin.math.abs(dy) -> if (dx < 0) VK_LEFT else VK_RIGHT
      else -> if (dy < 0) VK_UP else VK_DOWN
    }
    val current = dpadHeld[pointer] ?: 0
    if (current == vk) return
    if (current != 0) onKey?.invoke(current, NativeInput.ACTION_UP)
    if (vk != 0) onKey?.invoke(vk, NativeInput.ACTION_DOWN)
    dpadHeld[pointer] = vk
    dpad.pointer = if (up) -1 else pointer
    dpadDirection[pointer] = dx to dy
    if (up) {
      dpadHeld.remove(pointer)
      dpadDirection.remove(pointer)
      if (dpadHeld.isEmpty()) dpad.pointer = -1
    }
  }

  /** Releases everything: called when the activity pauses, so no key stays stuck. */
  fun releaseAll() {
    for (c in controls) {
      if (c.pointer >= 0) {
        c.pointer = -1
        onKey?.invoke(c.vk, NativeInput.ACTION_UP)
      }
    }
    for ((_, vk) in dpadHeld) onKey?.invoke(vk, NativeInput.ACTION_UP)
    dpadHeld.clear()
    dpadDirection.clear()
    dpad.pointer = -1
    onPad?.invoke(0, NativeInput.PAD_BUTTONS, 0f, 0f)
    invalidate()
  }

}

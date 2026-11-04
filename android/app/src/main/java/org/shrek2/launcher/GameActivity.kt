package org.shrek2.launcher

import android.os.Bundle
import android.widget.FrameLayout
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

/**
 * The whole Android front end: a SurfaceView handed to EGL, the touch overlay on top of it, and the
 * JNI calls that forward input to the native runtime.
 *
 * The game itself runs on a thread started by [nativeStart] and owns the surface: this activity only
 * forwards lifecycle, input and the install directory. Physical keyboards and pads are forwarded too,
 * so the game's own remapping screen behaves the same as on a desktop.
 */
class GameActivity : AppCompatActivity(), SurfaceHolder.Callback {

  private lateinit var surfaceView: SurfaceView
  private lateinit var overlay: TouchOverlayView

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    hideSystemBars()

    surfaceView = SurfaceView(this).apply {
      holder.addCallback(this@GameActivity)
      isFocusable = true
      isFocusableInTouchMode = true
      // The runtime does its own GLES setup on its own thread; the view must not allocate an EGL
      // context behind its back.
      holder.setFormat(android.graphics.PixelFormat.RGBA_8888)
    }
    overlay = TouchOverlayView(this)
    overlay.onKey = { vk, action -> nativeKey(vk, action) }
    overlay.onMouseMove = { dx, dy -> nativeMouseMove(dx, dy) }
    overlay.onMouseButton = { button, action -> nativeMouseButton(button, action) }
    overlay.onPad = { slot, what, a, b -> nativePad(slot, what, a, b) }

    val full = ViewGroup.LayoutParams.MATCH_PARENT
    val root = FrameLayout(this)
    root.addView(surfaceView, ViewGroup.LayoutParams(full, full))
    root.addView(overlay, ViewGroup.LayoutParams(full, full))
    setContentView(root)

    // The back gesture is the player's Escape key, not a request to destroy the activity (which
    // would kill the running guest).
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        nativeKey(VK_ESCAPE, ACTION_DOWN)
        nativeKey(VK_ESCAPE, ACTION_UP)
      }
    })
  }

  // ---- Surface ---------------------------------------------------------------------------------

  override fun surfaceCreated(holder: SurfaceHolder) {
    nativeSetSurface(holder.surface)
    nativeSurfaceSize(holder.surfaceFrame.width(), holder.surfaceFrame.height())
    // The image shipped inside the APK has to reach the cache directory before the loader runs.
    InstallFiles.unpackImage(this)
    // The game thread waits for the surface (game_main.cpp); start it once there is one.
    nativeStart(filesDir.absolutePath)
    surfaceView.requestFocus()
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
    nativeSurfaceSize(width, height)
  }

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    // The runtime keeps the guest alive without a window: it skips Present until a new one arrives.
    nativeSetSurface(null)
  }

  // ---- Lifecycle -------------------------------------------------------------------------------

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    nativeFocus(hasFocus)
    if (hasFocus) hideSystemBars()
  }

  override fun onPause() {
    super.onPause()
    // The guest keeps running (the game saves on its own schedule), but nothing may stay held: a
    // stuck key would make the player's character run into a wall after resuming.
    overlay.releaseAll()
    nativeFocus(false)
  }

  override fun onResume() {
    super.onResume()
    nativeFocus(true)
  }

  // ---- Input -----------------------------------------------------------------------------------

  private var gamepadButtons = 0
  private var gamepadSticks = floatArrayOf(0f, 0f, 0f, 0f)
  private var gamepadTriggers = floatArrayOf(0f, 0f)

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    // Controller buttons arrive as key events; their state is folded into the pad struct so the HLE
    // DirectInput layer sees one consistent device.
    if (isPadKey(keyCode)) {
      padKey(event, true)
      return true
    }
    val action = if (event.repeatCount > 0) NativeInput.ACTION_REPEAT else ACTION_DOWN
    return forwardKey(event, action) || super.onKeyDown(keyCode, event)
  }

  override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
    if (isPadKey(keyCode)) {
      padKey(event, false)
      return true
    }
    return forwardKey(event, ACTION_UP) || super.onKeyUp(keyCode, event)
  }

  /** Android key codes -> Win32 virtual-key codes; the native side owns the scancode mapping. */
  private fun forwardKey(event: KeyEvent, action: Int): Boolean {
    val vk = toVirtualKey(event.keyCode) ?: return false
    // Volume keys stay with the system so the player can always change the volume.
    if (vk == 0) return false
    nativeKey(vk, action)
    return true
  }

  private fun isPadKey(keyCode: Int): Boolean = when (keyCode) {
    KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_BUTTON_B, KeyEvent.KEYCODE_BUTTON_X, KeyEvent.KEYCODE_BUTTON_Y,
    KeyEvent.KEYCODE_BUTTON_L1, KeyEvent.KEYCODE_BUTTON_R1, KeyEvent.KEYCODE_BUTTON_L2, KeyEvent.KEYCODE_BUTTON_R2,
    KeyEvent.KEYCODE_BUTTON_START, KeyEvent.KEYCODE_BUTTON_SELECT, KeyEvent.KEYCODE_BUTTON_THUMBL,
    KeyEvent.KEYCODE_BUTTON_THUMBR, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN,
    KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> true
    else -> false
  }

  /**
   * Folds one controller button into the pad state. D-pad directions are reported as buttons rather
   * than as the analog hat, which keeps them usable in menus where the hat would be too imprecise.
   */
  private fun padKey(event: KeyEvent, down: Boolean) {
    // A physical d-pad on a keyboard-like device must not be swallowed: only devices that report a
    // joystick source are treated as pads.
    val pad = event.device?.sources ?: 0
    if (pad and InputDevice.SOURCE_GAMEPAD == 0 && pad and InputDevice.SOURCE_JOYSTICK == 0) {
      toVirtualKey(event.keyCode)?.let { vk -> if (vk != 0) nativeKey(vk, if (down) ACTION_DOWN else ACTION_UP) }
      return
    }
    val bit = when (event.keyCode) {
      KeyEvent.KEYCODE_BUTTON_A -> PAD_A
      KeyEvent.KEYCODE_BUTTON_B -> PAD_B
      KeyEvent.KEYCODE_BUTTON_X -> PAD_X
      KeyEvent.KEYCODE_BUTTON_Y -> PAD_Y
      KeyEvent.KEYCODE_BUTTON_L1 -> PAD_LB
      KeyEvent.KEYCODE_BUTTON_R1 -> PAD_RB
      KeyEvent.KEYCODE_BUTTON_L2 -> NativeInput.PAD_LT
      KeyEvent.KEYCODE_BUTTON_R2 -> NativeInput.PAD_RT
      KeyEvent.KEYCODE_BUTTON_START -> NativeInput.PAD_START
      KeyEvent.KEYCODE_BUTTON_SELECT -> NativeInput.PAD_BACK
      KeyEvent.KEYCODE_BUTTON_THUMBL -> PAD_LS
      KeyEvent.KEYCODE_BUTTON_THUMBR -> PAD_RS
      KeyEvent.KEYCODE_DPAD_UP -> NativeInput.PAD_UP
      KeyEvent.KEYCODE_DPAD_DOWN -> NativeInput.PAD_DOWN
      KeyEvent.KEYCODE_DPAD_LEFT -> NativeInput.PAD_LEFT
      KeyEvent.KEYCODE_DPAD_RIGHT -> NativeInput.PAD_RIGHT
      else -> 0
    }
    if (bit == 0) return
    gamepadButtons = if (down) gamepadButtons or bit else gamepadButtons and bit.inv()
    nativePad(0, PAD_BUTTONS, gamepadButtons.toFloat(), 0f)
  }

  override fun onGenericMotionEvent(event: MotionEvent): Boolean {
    if (event.source and InputDevice.SOURCE_JOYSTICK == InputDevice.SOURCE_JOYSTICK &&
      event.action == MotionEvent.ACTION_MOVE
    ) {
      forwardPad(event)
      return true
    }
    return super.onGenericMotionEvent(event)
  }

  /**
   * Axes of the pad in slot 0. Buttons are folded in by [padKey]: an axis event never carries the
   * button state, so reporting them here would drop a held button on the next stick move.
   */
  private fun forwardPad(event: MotionEvent) {
    val dead = 0.2f
    fun axis(i: Int) = if (kotlin.math.abs(event.getAxisValue(i)) < dead) 0f else event.getAxisValue(i)
    val lx = axis(MotionEvent.AXIS_X)
    val ly = axis(MotionEvent.AXIS_Y)
    val rx = axis(MotionEvent.AXIS_Z)
    val ry = axis(MotionEvent.AXIS_RZ)
    if (lx != gamepadSticks[0] || ly != gamepadSticks[1]) {
      gamepadSticks[0] = lx
      gamepadSticks[1] = ly
      nativePad(0, PAD_LEFT_STICK, lx, ly)
    }
    if (rx != gamepadSticks[2] || ry != gamepadSticks[3]) {
      gamepadSticks[2] = rx
      gamepadSticks[3] = ry
      nativePad(0, PAD_RIGHT_STICK, rx, ry)
    }
    val lt = event.getAxisValue(MotionEvent.AXIS_LTRIGGER)
    val rt = event.getAxisValue(MotionEvent.AXIS_RTRIGGER)
    if (lt != gamepadTriggers[0] || rt != gamepadTriggers[1]) {
      gamepadTriggers[0] = lt
      gamepadTriggers[1] = rt
      nativePad(0, PAD_TRIGGERS, lt, rt)
    }
  }

  override fun onStart() {
    super.onStart()
    // A pad that was already connected when we launched.
    val ids = InputDevice.getDeviceIds()
    for (id in ids) {
      val dev = InputDevice.getDevice(id) ?: continue
      if (dev.sources and InputDevice.SOURCE_JOYSTICK == InputDevice.SOURCE_JOYSTICK) nativePad(0, PAD_CONNECTED, 1f, 0f)
    }
  }

  private fun hideSystemBars() {
    window.insetsController?.let {
      it.hide(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
      it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
  }

  private companion object {
    const val ACTION_DOWN = NativeInput.ACTION_DOWN
    const val ACTION_UP = NativeInput.ACTION_UP
    const val ACTION_REPEAT = NativeInput.ACTION_REPEAT

    const val PAD_BUTTONS = NativeInput.PAD_BUTTONS
    const val PAD_LEFT_STICK = NativeInput.PAD_LEFT_STICK
    const val PAD_RIGHT_STICK = NativeInput.PAD_RIGHT_STICK
    const val PAD_TRIGGERS = NativeInput.PAD_TRIGGERS
    const val PAD_CONNECTED = NativeInput.PAD_CONNECTED

    const val PAD_A = NativeInput.PAD_A
    const val PAD_B = NativeInput.PAD_B
    const val PAD_X = NativeInput.PAD_X
    const val PAD_Y = NativeInput.PAD_Y
    const val PAD_LB = NativeInput.PAD_LB
    const val PAD_RB = NativeInput.PAD_RB
    const val PAD_LS = NativeInput.PAD_LS
    const val PAD_RS = NativeInput.PAD_RS

    const val VK_ESCAPE = NativeInput.VK_ESCAPE

    /** The subset of Android key codes the game can use, mapped to Win32 virtual keys. */
    fun toVirtualKey(keyCode: Int): Int? = when (keyCode) {
      KeyEvent.KEYCODE_ESCAPE, KeyEvent.KEYCODE_BACK -> 0x1b
      KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> 0x0d
      KeyEvent.KEYCODE_SPACE -> 0x20
      KeyEvent.KEYCODE_TAB -> 0x09
      KeyEvent.KEYCODE_DEL -> 0x08
      KeyEvent.KEYCODE_SHIFT_LEFT, KeyEvent.KEYCODE_SHIFT_RIGHT -> 0x10
      KeyEvent.KEYCODE_CTRL_LEFT, KeyEvent.KEYCODE_CTRL_RIGHT -> 0x11
      KeyEvent.KEYCODE_ALT_LEFT, KeyEvent.KEYCODE_ALT_RIGHT -> 0x12
      KeyEvent.KEYCODE_DPAD_LEFT -> 0x25
      KeyEvent.KEYCODE_DPAD_UP -> 0x26
      KeyEvent.KEYCODE_DPAD_RIGHT -> 0x27
      KeyEvent.KEYCODE_DPAD_DOWN -> 0x28
      KeyEvent.KEYCODE_MOVE_HOME -> 0x24
      KeyEvent.KEYCODE_MOVE_END -> 0x23
      KeyEvent.KEYCODE_PAGE_UP -> 0x21
      KeyEvent.KEYCODE_PAGE_DOWN -> 0x22
      KeyEvent.KEYCODE_INSERT -> 0x2d
      KeyEvent.KEYCODE_FORWARD_DEL -> 0x2e
      KeyEvent.KEYCODE_F1 -> 0x70
      KeyEvent.KEYCODE_F2 -> 0x71
      KeyEvent.KEYCODE_F3 -> 0x72
      KeyEvent.KEYCODE_F4 -> 0x73
      KeyEvent.KEYCODE_F5 -> 0x74
      KeyEvent.KEYCODE_F6 -> 0x75
      KeyEvent.KEYCODE_F7 -> 0x76
      KeyEvent.KEYCODE_F8 -> 0x77
      KeyEvent.KEYCODE_F9 -> 0x78
      KeyEvent.KEYCODE_F10 -> 0x79
      KeyEvent.KEYCODE_F11 -> 0x7a
      KeyEvent.KEYCODE_F12 -> 0x7b
      // 0 means "handled by the system": the volume keys must keep working.
      KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN -> 0
      else -> when (keyCode) {
        in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> ('A'.code + (keyCode - KeyEvent.KEYCODE_A))
        in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> ('0'.code + (keyCode - KeyEvent.KEYCODE_0))
        else -> null
      }
    }
  }

  // ---- JNI -------------------------------------------------------------------------------------

  private external fun nativeSetSurface(surface: Surface?)
  private external fun nativeSurfaceSize(width: Int, height: Int)
  private external fun nativeKey(vk: Int, action: Int)
  private external fun nativePad(slot: Int, what: Int, a: Float, b: Float)
  private external fun nativeFocus(focused: Boolean)
  private external fun nativeMouseMove(dx: Float, dy: Float)
  private external fun nativeMouseButton(button: Int, action: Int)
  private external fun nativeMouseTo(x: Int, y: Int)
  private external fun nativeStart(filesDir: String)

  init {
    System.loadLibrary("shrek2")
  }
}

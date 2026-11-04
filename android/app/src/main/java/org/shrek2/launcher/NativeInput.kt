package org.shrek2.launcher

/**
 * The wire constants shared by the activity, the touch overlay and the native layer
 * (`platform_android.cpp`, `game_main.cpp`). Everything the game sees is a Windows message, so keys
 * travel as virtual-key codes and pads as W3C "standard" button bits.
 */
object NativeInput {
  // Key actions, matching the `action` argument of GameActivity.nativeKey.
  const val ACTION_UP = 0
  const val ACTION_DOWN = 1
  const val ACTION_REPEAT = 2

  // `what` values of GameActivity.nativePad.
  const val PAD_BUTTONS = 0
  const val PAD_LEFT_STICK = 1
  const val PAD_RIGHT_STICK = 2
  const val PAD_TRIGGERS = 3
  const val PAD_CONNECTED = 4

  // W3C standard gamepad buttons, the order plat::PadButton documents in platform.h.
  const val PAD_A = 1
  const val PAD_B = 2
  const val PAD_X = 4
  const val PAD_Y = 8
  const val PAD_LB = 16
  const val PAD_RB = 32
  const val PAD_LT = 64
  const val PAD_RT = 128
  const val PAD_BACK = 256
  const val PAD_START = 512
  const val PAD_LS = 1024
  const val PAD_RS = 2048
  const val PAD_UP = 4096
  const val PAD_DOWN = 8192
  const val PAD_LEFT = 16384
  const val PAD_RIGHT = 32768

  // Win32 virtual-key codes the overlay and the keyboard map onto.
  const val VK_ESCAPE = 0x1b
  const val VK_RETURN = 0x0d
  const val VK_SPACE = 0x20
  const val VK_SHIFT = 0x10
  const val VK_CONTROL = 0x11
  const val VK_MENU = 0x12
  const val VK_LEFT = 0x25
  const val VK_UP = 0x26
  const val VK_RIGHT = 0x27
  const val VK_DOWN = 0x28

  /** Human-readable name for a virtual-key code (overlay labels and the binding screen). */
  fun keyLabel(vk: Int): String = when {
    vk == VK_ESCAPE -> "ESC"
    vk == VK_RETURN -> "ENTER"
    vk == VK_SPACE -> "SPACE"
    vk == VK_SHIFT -> "SHIFT"
    vk == VK_CONTROL -> "CTRL"
    vk == VK_MENU -> "ALT"
    vk == VK_LEFT -> "LEFT"
    vk == VK_UP -> "UP"
    vk == VK_RIGHT -> "RIGHT"
    vk == VK_DOWN -> "DOWN"
    vk in 'A'.code..'Z'.code || vk in '0'.code..'9'.code -> vk.toChar().toString()
    vk in 0x70..0x7b -> "F${vk - 0x6f}"
    else -> "VK$vk"
  }
}

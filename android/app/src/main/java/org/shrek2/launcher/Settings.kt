package org.shrek2.launcher

/**
 * The game's graphics settings, as the original Launcher (`Game/Launcher.exe`) exposed them: values in
 * the virtual registry that the game reads at start-up. A port of the parts of `web/src/settings.ts`
 * that the launcher screen needs; the full keyboard/gamepad editor stays on the web page.
 *
 * - `resolution`: index into [RESOLUTIONS]. The runtime presents the game at this size and scales it to
 *   the surface, so a phone is not asked for a 1280x1024 swap chain.
 * - `options`: bit 0x2 detailed shadows, bit 0x20 anti-aliasing, bit 0x100 distance clipping (with
 *   `distance` 0..100). Missing values read as 0xFFFFFFFF in the engine, so every value is written.
 *
 * The defaults and the writing order match the web page exactly, so a registry written here and one
 * written by the browser are interchangeable.
 */
object Settings {

  const val KEY = Registry.SETTINGS_KEY

  val RESOLUTIONS = listOf("640 × 480", "800 × 600", "1024 × 768", "1280 × 1024")

  const val OPT_SHADOWS = 0x2
  const val OPT_ANTIALIAS = 0x20
  const val OPT_CLIPPING = 0x100

  /** Marks the launcher's own defaults, beside the game's values (the game ignores it). */
  private const val LAUNCHER_DEFAULTS = "webdefaults"

  /** Version of the defaults in [defaults]; the game's own values are migrated when an older one is found. */
  private const val DEFAULTS_VERSION = 2

  class Graphics(
    /** 0..3, see [RESOLUTIONS]. */
    var resolution: Int = 2,
    var shadows: Boolean = true,
    var antiAliasing: Boolean = true,
    var clipping: Boolean = true,
    /** 0..100, distance clipping. */
    var distance: Int = 100,
  ) {
    /** The `options` dword these switches add up to. */
    fun options(): Int =
      (if (shadows) OPT_SHADOWS else 0) or (if (antiAliasing) OPT_ANTIALIAS else 0) or (if (clipping) OPT_CLIPPING else 0)

    /** Human-readable size, as the launcher shows it. */
    fun resolutionLabel(): String = RESOLUTIONS[resolution.coerceIn(0, RESOLUTIONS.lastIndex)]
  }

  /** The game's own defaults: 1024 × 768, shadows + anti-aliasing + clipping, full distance. */
  fun defaults() = Graphics()

  /** True once the game's settings were written (the game reads missing values as 0xFFFFFFFF). */
  fun hasSettings(registry: Registry): Boolean = registry.dword(KEY, "resolution") != null

  fun read(registry: Registry): Graphics {
    val d = defaults()
    val dw = { name: String, fallback: Int -> registry.dword(KEY, name, fallback)!! }
    val options = dw("options", d.options())
    return Graphics(
      resolution = dw("resolution", d.resolution).coerceIn(0, RESOLUTIONS.lastIndex),
      shadows = options and OPT_SHADOWS != 0,
      antiAliasing = options and OPT_ANTIALIAS != 0,
      clipping = options and OPT_CLIPPING != 0,
      distance = dw("distance", d.distance).coerceIn(0, 100),
    )
  }

  /**
   * Write the graphics values, leaving key and pad bindings untouched. Everything else the game needs is
   * written on the first call ([ensureDefaults]): the controller GUIDs must be present or the game does
   * not see a pad at all.
   */
  fun write(registry: Registry, g: Graphics) {
    registry.setDword(KEY, LAUNCHER_DEFAULTS, DEFAULTS_VERSION)
    registry.setDword(KEY, "resolution", g.resolution.coerceIn(0, RESOLUTIONS.lastIndex))
    registry.setDword(KEY, "options", g.options())
    registry.setDword(KEY, "distance", g.distance.coerceIn(0, 100))
    // Written back so a fresh install has the values the game reads (missing reads as 0xFFFFFFFF).
    registry.setDword(KEY, "mouseenable", if (registry.dword(KEY, "mouseenable", 1) != 0) 1 else 0)
    registry.setDword(KEY, "mousesens", registry.dword(KEY, "mousesens", 100)!!)
    registry.setDword(KEY, "mousewheel", if (registry.dword(KEY, "mousewheel", 1) != 0) 1 else 0)
    registry.setDword(KEY, "mousebindl", registry.dword(KEY, "mousebindl", 0)!!)
    registry.setDword(KEY, "mousebindr", registry.dword(KEY, "mousebindr", 0)!!)
    registry.setDword(KEY, "mousebindm", registry.dword(KEY, "mousebindm", 0)!!)
  }

  /**
   * The game's settings, ready for a start: the Launcher's key and gamepad layout and the controller
   * GUIDs on the first run, the player's own values after that. Mirrors `prepareSettings` in
   * `web/src/settings.ts` (including its version-1 migration), so a settings file written by the web
   * build is understood here and vice versa.
   */
  fun prepareDefaults(registry: Registry) {
    migrate(registry)
    // Keyboard: the game's own layout for player 1 (WinMain 0x4a8ef1); the other players are unbound.
    for ((a, code) in GAME_KEYS.withIndex()) {
      if (registry.dword(KEY, "k0_$a") == null) registry.setDword(KEY, "k0_$a", code)
    }
    for (p in 0 until PLAYERS) {
      for (a in GAME_KEYS.indices) {
        if (registry.dword(KEY, "k${p}_$a") == null) registry.setDword(KEY, "k${p}_$a", if (p == 0) GAME_KEYS[a] else 0)
        if (registry.dword(KEY, "gp${p}_$a") == null) registry.setDword(KEY, "gp${p}_$a", DEFAULT_PAD[a])
      }
      registry.setSz(KEY, "pad$p", padGuid(p))
    }
    write(registry, read(registry))
  }

  // ---- The game's own layouts (see web/src/settings.ts for the addresses they come from) -----------

  private const val PLAYERS = 4

  /** The game's default keyboard layout: arrows, Num 8/2/4/6, Space Z X C, Esc, A/S, D. */
  private val GAME_KEYS = listOf(0xc8, 0xd0, 0xcb, 0xcd, 0x48, 0x50, 0x4b, 0x4d, 0x39, 0x2c, 0x2d, 0x2e, 0x01, 0x1e, 0x1f, 0x20)

  /** The Launcher's manual layout (W S A D ...), offered as a preset on the web page. */
  val MANUAL_KEYS = listOf(0x11, 0x1f, 0x1e, 0x20, 0xc8, 0xd0, 0xcb, 0xcd, 0x39, 0x21, 0x1c, 0x2a, 0x01, 0x4f, 0x50, 0x0f)

  /** An Xbox-style layout, for every player (the 2004 defaults describe a pad nobody has). */
  private val DEFAULT_PAD = listOf(
    2, 2, // left stick up/down
    1, 1, // left stick left/right
    7, 7, // right stick up/down: zoom
    6, 6, // right stick left/right: camera
    11, // A: Jump
    12, // B: Use
    13, // X: Attack
    14, // Y: Special
    18, // Start
    16, // RB: Next Character
    15, // LB: Previous Character
    17, // Back: Display HUD
  )

  /** Virtual pad p's instance GUID as the game's parser (0x5935d0) expects it. */
  fun padGuid(p: Int): String = "53324750-4144-0001-8000-00000000000$p"

  /**
   * Version 1 of the web defaults wrote the manual's keys and mouse buttons; settings that still hold
   * exactly those go back to the game's own layout.
   */
  private fun migrate(registry: Registry) {
    if (registry.dword(KEY, LAUNCHER_DEFAULTS, 1)!! >= DEFAULTS_VERSION || !hasSettings(registry)) return
    val dw = { name: String -> registry.dword(KEY, name) }
    if (MANUAL_KEYS.withIndex().all { (a, k) -> dw("k0_$a") == k }) {
      for ((a, k) in GAME_KEYS.withIndex()) registry.setDword(KEY, "k0_$a", k)
    }
    if (dw("mousebindl") == 0x6 && dw("mousebindr") == 0x4 && dw("mousebindm") == 0x5) {
      for (n in listOf("mousebindl", "mousebindr", "mousebindm")) registry.setDword(KEY, n, 0)
    }
  }
}

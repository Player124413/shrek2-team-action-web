package org.shrek2.launcher

import java.io.File

/**
 * The engine's virtual registry file, as the launcher sees it — a port of `web/src/registry.ts`.
 *
 * The runtime reads `registry.txt` from the app-private root (`rt::registry_init` in `game_main.cpp`);
 * the file is one `key<TAB>name<TAB>dword|sz<TAB>value` line per value, keys and names in lower case.
 * The game only reads it, so the launcher may rewrite it whenever the game is not running.
 */
class Registry private constructor(private val keys: LinkedHashMap<String, LinkedHashMap<String, Value>>) {

  sealed class Value {
    data class Dword(val value: Long) : Value()
    data class Sz(val value: String) : Value()
  }

  companion object {
    /** The key the game reads its settings from (loader 0x593cf0 and WinMain). */
    const val SETTINGS_KEY = "hkcu\\software\\activision\\shrek 2 team action\\settings"

    fun parse(text: String): Registry {
      val r = Registry(LinkedHashMap())
      for (raw in text.split("\n")) {
        val line = raw.removeSuffix("\r")
        val parts = line.split("\t")
        if (parts.size < 3) continue
        val key = parts[0]
        val name = parts[1]
        val type = parts[2]
        val value = parts.drop(3).joinToString("\t")
        if (key.isEmpty() || name.isEmpty()) continue
        when (type) {
          "dword" -> r.set(key, name, Value.Dword(value.toLongOrNull()?.and(0xffffffffL) ?: 0L))
          "sz" -> r.set(key, name, Value.Sz(value))
        }
      }
      return r
    }

    fun load(file: File): Registry = parse(if (file.isFile) file.readText() else "")

    /** Written through a temporary file: a half-written registry would lose the player's bindings. */
    fun save(file: File, registry: Registry) {
      file.parentFile?.mkdirs()
      val tmp = File(file.parentFile, "${file.name}.tmp")
      tmp.writeText(registry.serialize())
      if (!tmp.renameTo(file)) {
        file.delete()
        tmp.renameTo(file)
      }
    }
  }

  fun serialize(): String {
    val out = StringBuilder()
    for ((key, values) in keys) {
      for ((name, v) in values) {
        out.append(key).append('\t').append(name).append('\t')
        when (v) {
          is Value.Dword -> out.append("dword\t").append(v.value and 0xffffffffL)
          is Value.Sz -> out.append("sz\t").append(v.value.replace("\n", " "))
        }
        out.append('\n')
      }
    }
    return out.toString()
  }

  fun get(key: String, name: String): Value? = keys[key.lowercase()]?.get(name.lowercase())

  /** The value as an integer; missing and non-dword values read as the fallback. */
  fun dword(key: String, name: String, fallback: Int? = null): Int? =
    (get(key, name) as? Value.Dword)?.value?.toInt() ?: fallback

  fun sz(key: String, name: String): String? = (get(key, name) as? Value.Sz)?.value

  fun set(key: String, name: String, value: Value) {
    keys.getOrPut(key.lowercase()) { LinkedHashMap() }[name.lowercase()] = value
  }

  fun setDword(key: String, name: String, value: Int) = set(key, name, Value.Dword(value.toLong() and 0xffffffffL))

  fun setSz(key: String, name: String, value: String) = set(key, name, Value.Sz(value))
}

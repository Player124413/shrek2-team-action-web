package org.shrek2.launcher.install

import java.io.IOException

/**
 * The installer's error types.
 *
 * A disc can be wrong in ways the player can act on -- a truncated image, a damaged file, a disc that is
 * not the game -- and the launcher has to say which. A raw bounds failure ("read [x, +y) outside source
 * of size z") tells nobody anything, so every check in the readers raises one of these instead; the
 * launcher shows the message, and the message names the file and what to do about it.
 */
open class InstallException(message: String, cause: Throwable? = null) : IOException(message, cause)

/** The image itself is not usable (not ISO 9660, truncated, missing its volume descriptors). */
class DiscException(message: String, cause: Throwable? = null) : InstallException(message, cause)

/** One file on the disc is damaged or incomplete, or cannot be read out of it ([what] names it). */
class MemberException(what: String, message: String, cause: Throwable? = null) :
  InstallException("$what: $message", cause)

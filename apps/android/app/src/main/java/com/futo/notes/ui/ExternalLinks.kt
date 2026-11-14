package com.futo.notes.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

/** A schemeless destination that is a web address: dotted host labels, an optional port and path. `.md` is the
 *  note extension, so `other.md` is a note's file name, not a domain. */
private val SCHEMELESS_HOST = Regex(
    """^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?!md(?:[:/?#]|$))[a-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$""",
    RegexOption.IGNORE_CASE,
)

/** The URL an external-link tap hands the system, or null when it is not one to open: only
 *  `http`/`https`/`mailto`/`tel` pass, and a destination with no scheme that names a host
 *  (`futo.org`, `www.example.org/a`) is read as `https`. */
internal fun externalLinkTarget(url: String): String? {
    if (SCHEMELESS_HOST.matches(url)) return "https://$url"
    val scheme = url.substringBefore(':', "").lowercase()
    return url.takeIf { scheme in setOf("http", "https", "mailto", "tel") }
}

/** The scheme-guarded `ACTION_VIEW` behind every external-link tap, native editor.
 *  False when nothing was opened, so a caller can leave the tap to the editor. */
internal fun openExternalUrl(context: Context, url: String): Boolean {
    val target = externalLinkTarget(url) ?: return false
    val uri = runCatching { Uri.parse(target) }.getOrNull() ?: return false
    return try {
        context.startActivity(
            Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        true
    } catch (e: Exception) {
        Log.w("FutoEditor", "No app to open external URL $url", e)
        false
    }
}

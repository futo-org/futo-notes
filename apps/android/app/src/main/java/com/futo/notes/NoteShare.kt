package com.futo.notes

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException

/**
 * Share-sheet launch for a note. Small notes travel as `EXTRA_TEXT`; a big body
 * would blow the ~1 MB Binder transaction limit (the intent is marshalled to the
 * system server and again into the chooser), which surfaces as a fatal
 * `RuntimeException: Failure from system` out of `startActivity` (crash #1812).
 * Those go out as a `.md` file behind the app's FileProvider instead.
 */
object NoteShare {
    /**
     * Largest body shared inline. Far below the 1 MB limit, which every other
     * in-flight transaction in the process also draws from, and the chooser
     * carries a second copy of the extras.
     */
    const val MAX_INLINE_BYTES = 64 * 1024

    private const val SHARE_DIR = "share"
    private const val FALLBACK_FILE_STEM = "note"
    private const val MAX_STEM_CHARS = 80

    fun sharesInline(text: String): Boolean = text.toByteArray(Charsets.UTF_8).size <= MAX_INLINE_BYTES

    /** A file name for the shared copy: the title with path-hostile characters dropped. */
    fun fileName(title: String): String {
        val stem = title.filterNot { it.isISOControl() || it in "\\/:*?\"<>|" }.trim().trim('.')
        return "${stem.ifEmpty { FALLBACK_FILE_STEM }.take(MAX_STEM_CHARS)}.md"
    }

    /** Builds the chooser intent, staging a file when the body is too big to inline. */
    fun chooserIntent(context: Context, title: String, text: String, chooserTitle: String): Intent {
        val send = Intent(Intent.ACTION_SEND).apply {
            putExtra(Intent.EXTRA_TITLE, title)
            if (sharesInline(text)) {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            } else {
                val dir = File(context.cacheDir, SHARE_DIR).apply { mkdirs() }
                // One staged note at a time; the previous share is long consumed.
                dir.listFiles()?.forEach { it.delete() }
                val file = File(dir, fileName(title)).apply { writeText(text, Charsets.UTF_8) }
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
                type = "text/markdown"
                putExtra(Intent.EXTRA_STREAM, uri)
                // ClipData carries the grant to the chosen target.
                clipData = ClipData.newRawUri(title, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }
        return Intent.createChooser(send, chooserTitle)
    }

    /** Launches the share sheet; false when the system refused, so the caller can tell the user. */
    fun share(context: Context, title: String, text: String, chooserTitle: String): Boolean = try {
        context.startActivity(chooserIntent(context, title, text, chooserTitle))
        true
    } catch (e: RuntimeException) {
        // Binder rejection ("Failure from system"), no chooser, or a
        // FileProvider refusal: none of it is worth a crash.
        Log.w("NoteShare", "share failed", e)
        false
    } catch (e: IOException) {
        Log.w("NoteShare", "could not stage the note for sharing", e)
        false
    }
}

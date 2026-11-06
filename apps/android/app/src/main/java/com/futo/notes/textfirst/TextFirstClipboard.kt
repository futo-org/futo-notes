package com.futo.notes.textfirst

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputContentInfo

/**
 * Copy, cut and paste for the note view, plus keyboard-provided content. An image
 * never also becomes text: its owner takes the URI and calls the release when done.
 */
internal class TextFirstClipboard(
    private val context: Context,
    private val selectAll: (EditorEngine) -> Unit = { it.selectAll() },
    private val engine: () -> EditorEngine?,
) {
    var onImageContent: ((Uri, () -> Unit) -> Boolean)? = null
    /** The system clipboard refused a Copy or Cut; nothing was removed. UI thread. */
    var onCopyRefused: () -> Unit = {}
    private val main = Handler(Looper.getMainLooper())

    fun handle(id: Int): Boolean {
        val engine = engine() ?: return false
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        when (id) {
            android.R.id.copy, android.R.id.cut -> engine.copy(cut = id == android.R.id.cut) { markdown ->
                // A clip over about 1 MB exceeds the binder transaction limit and throws.
                try {
                    clipboard.setPrimaryClip(ClipData.newPlainText(null, markdown))
                    true
                } catch (e: RuntimeException) {
                    Log.w("TextFirstClipboard", "clipboard refused ${markdown.length} chars", e)
                    main.post { onCopyRefused() }
                    false
                }
            }
            android.R.id.paste, android.R.id.pasteAsPlainText -> {
                val clip = clipboard.primaryClip
                val image = clipImageUri(clip, context.contentResolver)
                if (image != null) { onImageContent?.invoke(image) {}; return true }
                val text = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(context)?.toString() else null
                if (!text.isNullOrEmpty()) engine.paste(text)
            }
            android.R.id.selectAll -> selectAll(engine)
            android.R.id.undo -> engine.undo()
            android.R.id.redo -> engine.redo()
            else -> return false
        }
        return true
    }

    /** Accept an image from the keyboard; [onUi] hops to the UI thread from the editor thread. */
    fun commitContent(info: InputContentInfo, flags: Int, onUi: (() -> Unit) -> Unit): Boolean {
        if (!info.description.hasMimeType("image/*") || onImageContent == null) return false
        val granted = flags and InputConnection.INPUT_CONTENT_GRANT_READ_URI_PERMISSION != 0
        if (granted) {
            try { info.requestPermission() } catch (e: RuntimeException) { return false }
        }
        onUi {
            val handler = onImageContent
            val release: () -> Unit = { if (granted) runCatching { info.releasePermission() } }
            if (handler == null || !handler(info.contentUri, release)) release()
        }
        return true
    }
}

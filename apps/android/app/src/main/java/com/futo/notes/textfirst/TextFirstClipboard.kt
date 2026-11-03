package com.futo.notes.textfirst

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputContentInfo

/**
 * Copy, cut and paste for the note view, plus keyboard-provided content. An image
 * never also becomes text: its owner takes the URI and calls the release when done.
 */
internal class TextFirstClipboard(private val context: Context, private val engine: () -> EditorEngine?) {
    var onImageContent: ((Uri, () -> Unit) -> Boolean)? = null

    fun handle(id: Int): Boolean {
        val engine = engine() ?: return false
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        when (id) {
            android.R.id.copy, android.R.id.cut -> engine.copy(cut = id == android.R.id.cut) { markdown ->
                clipboard.setPrimaryClip(ClipData.newPlainText(null, markdown))
            }
            android.R.id.paste, android.R.id.pasteAsPlainText -> {
                val clip = clipboard.primaryClip
                val image = clipImageUri(clip, context.contentResolver)
                if (image != null) { onImageContent?.invoke(image) {}; return true }
                val text = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(context)?.toString() else null
                if (!text.isNullOrEmpty()) engine.paste(text)
            }
            android.R.id.selectAll -> engine.selectAll()
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

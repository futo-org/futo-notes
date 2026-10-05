package com.futo.notes.ui

import java.util.concurrent.atomic.AtomicBoolean

internal class EditorAttachmentToken internal constructor(
    internal val generation: Long,
)

/**
 * Owns the identity of the note currently attached to the app-lifetime
 * WebView. Async work captures a token and must still hold the current token
 * before it may mutate the editor.
 */
internal class EditorAttachmentGate {
    private var generation = 0L
    private var isAttached = false

    fun attach(): EditorAttachmentToken {
        generation += 1
        isAttached = true
        return EditorAttachmentToken(generation)
    }

    fun detach(token: EditorAttachmentToken) {
        if (!permits(token)) return
        isAttached = false
        generation += 1
    }

    fun current(): EditorAttachmentToken? =
        if (isAttached) EditorAttachmentToken(generation) else null

    fun permits(token: EditorAttachmentToken): Boolean =
        isAttached && token.generation == generation
}

/**
 * A rename keeps the live editor document, but the screen re-keys on the new
 * id and so detaches and re-attaches the shell's bindings. That re-attach is a
 * continuation of the same open note, not a fresh open: it must not repeat the
 * open-time focus (a blur/refocus bounce that drops an IME commit landing in
 * its window) or report the editor unfocused while the user is still typing.
 */
internal class EditorRenameHandover {
    private var toId: String? = null

    /** The live document was relabeled to [toId]; the next attach for it continues. */
    fun begin(toId: String) { this.toId = toId }

    /** A rename's detach is under way; the editor keeps the focus it had. */
    val pending: Boolean get() = toId != null

    /** True when this attach is the rename's re-key; any attach ends the handover. */
    fun consume(noteId: String): Boolean {
        val expected = toId
        toId = null
        return expected == noteId
    }
}

internal class EditorAttachmentOperationPermit(
    private val attachments: EditorAttachmentGate,
    private val attachment: EditorAttachmentToken,
) {
    private val isActive = AtomicBoolean(true)

    fun cancel() {
        isActive.set(false)
    }

    fun mayRun(): Boolean =
        isActive.get() && attachments.permits(attachment)
}

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

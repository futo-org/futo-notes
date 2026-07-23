package com.futo.notes.ui

import uniffi.futo_notes_ffi.FlushDisposition

internal data class EditorNavigationCommit(
    val savedContent: String,
    val canNavigate: Boolean,
)

internal class EditorNavigationAdmission {
    private var isStarted = false

    fun tryBegin(): Boolean {
        if (isStarted) return false
        isStarted = true
        return true
    }

    fun retryAfterFailure() {
        isStarted = false
    }
}

internal suspend fun commitEditorNavigationSnapshot(
    savedContent: String,
    content: String,
    flush: suspend (base: String, content: String) -> FlushDisposition?,
): EditorNavigationCommit {
    if (content == savedContent) {
        return EditorNavigationCommit(savedContent, canNavigate = true)
    }
    val disposition = flush(savedContent, content)
    return EditorNavigationCommit(
        savedContent = if (disposition != null) content else savedContent,
        canNavigate = disposition != null,
    )
}

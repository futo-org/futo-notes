package com.futo.notes.ui

import com.futo.notes.NoteMutationOutcome
import uniffi.futo_notes_ffi.FlushDisposition
import uniffi.futo_notes_ffi.makeId
import uniffi.futo_notes_ffi.sanitizeTitle
import uniffi.futo_notes_ffi.splitId
import uniffi.futo_notes_ffi.validateTitle

internal data class EditorNavigationCommit(
    val savedContent: String,
    val canNavigate: Boolean,
    val disposition: FlushDisposition? = null,
)

internal data class EditorTitleCommit(
    val id: String,
    val isCommitted: Boolean,
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

internal fun isEditorInteractionEnabled(navigationPending: Boolean): Boolean =
    !navigationPending

internal fun shouldStartEditorBackNavigation(navigationPending: Boolean): Boolean =
    !navigationPending

internal fun canNavigateWithoutEditorAttachment(webViewTooOld: Boolean): Boolean =
    webViewTooOld

internal suspend fun commitEditorTitleSnapshot(
    currentId: String,
    targetId: String?,
    rename: suspend (oldId: String, targetId: String) -> NoteMutationOutcome<String>,
): EditorTitleCommit {
    if (targetId == null || targetId == currentId) {
        return EditorTitleCommit(currentId, isCommitted = true)
    }
    return when (val outcome = rename(currentId, targetId)) {
        is NoteMutationOutcome.Committed ->
            EditorTitleCommit(outcome.value, isCommitted = true)
        NoteMutationOutcome.Failed ->
            EditorTitleCommit(currentId, isCommitted = false)
    }
}

internal fun editorTitleTarget(
    currentId: String,
    rawTitle: String,
    existingIds: Set<String>,
): String? {
    val trimmed = rawTitle.trim()
    if (trimmed.isEmpty()) return null
    if (validateTitle(trimmed).any { it.kind != "empty" }) return null
    val parts = splitId(currentId)
    val clean = sanitizeTitle(trimmed)
    if (clean == parts.title) return null
    val target = makeId(parts.folder, clean)
    if (target != currentId && target in existingIds) return null
    return target
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
        disposition = disposition,
    )
}

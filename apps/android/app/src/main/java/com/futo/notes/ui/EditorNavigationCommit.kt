package com.futo.notes.ui

import com.futo.notes.CommittedNote
import com.futo.notes.NoteMutationOutcome
import com.futo.notes.rebasedOnRelink
import kotlinx.coroutines.withTimeoutOrNull
import uniffi.futo_notes_ffi.FlushDisposition
import uniffi.futo_notes_ffi.makeId
import uniffi.futo_notes_ffi.sanitizeTitle
import uniffi.futo_notes_ffi.splitId
import uniffi.futo_notes_ffi.validateTitle

internal suspend fun insertImageWithinDeadline(
    deadlineMs: Long,
    insert: suspend () -> Boolean,
): Boolean = withTimeoutOrNull(deadlineMs) { insert() } ?: false

internal data class EditorNavigationCommit(
    val savedContent: String,
    val canNavigate: Boolean,
    val disposition: FlushDisposition? = null,
)

internal data class EditorTitleCommit(
    val id: String,
    val isCommitted: Boolean,
    /** The body the relink left in the renamed note (a self-link), if it rewrote it. */
    val relinkedBody: String? = null,
)

internal suspend fun commitEditorTitleSnapshot(
    currentId: String,
    targetId: String?,
    rename: suspend (oldId: String, targetId: String) -> NoteMutationOutcome<CommittedNote>,
): EditorTitleCommit {
    if (targetId == null || targetId == currentId) {
        return EditorTitleCommit(currentId, isCommitted = true)
    }
    return when (val outcome = rename(currentId, targetId)) {
        is NoteMutationOutcome.Committed ->
            EditorTitleCommit(outcome.value.id, isCommitted = true, relinkedBody = outcome.value.relinkedBody)
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


/** Rebase each refused conditional relink against the next delivered document. */
internal suspend fun settleRelinkAdoption(
    flushed: String,
    relinkedBody: String,
    awaitCurrent: suspend () -> EditorCurrent,
    liveContent: () -> String,
    receiveChange: (String) -> Unit,
    setBaseline: (String) -> Unit,
    apply: suspend (String, Long) -> Boolean,
) {
    repeat(3) {
        val current = awaitCurrent()
        if (!current.canProceed) return
        current.latest?.let { if (it.content != liveContent()) receiveChange(it.content) }
        val rebase = rebasedOnRelink(flushed, liveContent(), relinkedBody)
        setBaseline(rebase.savedContent)
        if (!rebase.adoptIntoEditor) return
        val generation = current.latest?.generation ?: return
        if (apply(rebase.content, generation)) return
    }
}

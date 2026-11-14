package com.futo.notes.ui

import com.futo.notes.CommittedNote
import com.futo.notes.NoteMutationOutcome
import uniffi.futo_notes_ffi.collisionKey
import uniffi.futo_notes_ffi.makeId
import uniffi.futo_notes_ffi.sanitizeTitle
import uniffi.futo_notes_ffi.splitId
import uniffi.futo_notes_ffi.validateTitle

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

/**
 * Would naming this note [targetId] land on a DIFFERENT note's name? The store
 * resolves collisions case- and NFC-insensitively, so this compares each id's
 * Rust `collisionKey` rather than the ids themselves — `QA ALPHA` beside
 * `qa alpha` is a duplicate, not a `QA ALPHA-2` rename [editor.md, list.md].
 */
internal fun collidesWithOtherNote(
    currentId: String,
    targetId: String,
    existingIds: Collection<String>,
    key: (String) -> String = ::collisionKey,
): Boolean {
    val targetKey = key(targetId)
    return existingIds.any { it != currentId && key(it) == targetKey }
}

internal fun editorTitleTarget(
    currentId: String,
    rawTitle: String,
    existingIds: Collection<String>,
): String? {
    val trimmed = rawTitle.trim()
    if (trimmed.isEmpty()) return null
    if (validateTitle(trimmed).any { it.kind != "empty" }) return null
    val parts = splitId(currentId)
    val clean = sanitizeTitle(trimmed)
    if (clean == parts.title) return null
    val target = makeId(parts.folder, clean)
    if (collidesWithOtherNote(currentId, target, existingIds)) return null
    return target
}

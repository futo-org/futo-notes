package com.futo.notes.ui

import com.futo.notes.NoteMutationOutcome
import uniffi.futo_notes_ffi.FlushDisposition
import uniffi.futo_notes_ffi.makeId
import uniffi.futo_notes_ffi.sanitizeTitle
import uniffi.futo_notes_ffi.splitId
import uniffi.futo_notes_ffi.validateTitle

/**
 * What an exit's attempt to read the open editor came back with.
 *
 * Three cases, because `null` used to mean two opposite things and the
 * difference decides whether the user can leave the screen at all. An editor
 * that answered with its document, an editor that CANNOT be holding anything
 * this shell has not already seen, and an editor that now belongs to another
 * note are three different situations; folding the middle one into "could not
 * read" is what trapped a user on a note whose editor never mounted.
 */
internal sealed interface EditorCaptureOutcome {
    /** The editor answered with its live document. */
    data class Captured(val text: String) : EditorCaptureOutcome

    /**
     * There is no live document to read. The bundle has not reported
     * `initialized`, the page has no `window.FutoEditor` (the legacy-WebView
     * notice, or a boot that failed), or it stopped answering altogether — a
     * renderer whose JS thread is stuck on a parse that will not finish inside
     * any deadline. None of those can be holding a user edit, because none of
     * them ever presented an editable document.
     */
    data object NoLiveDocument : EditorCaptureOutcome

    /**
     * A different note owns the shared app-lifetime WebView now, so reading it
     * would answer for the WRONG document.
     */
    data object NotOurs : EditorCaptureOutcome
}

/**
 * The body an exit should commit, given what the capture came back with.
 *
 * `null` means REFUSE the exit — [EditorSession] turns it into
 * [EditorExitFailure.CAPTURE] and the screen stays put. That is reserved for
 * the one genuinely ambiguous case, [EditorCaptureOutcome.NotOurs]: reading the
 * WebView would hand back another note's text, and leaving on it could discard
 * an edit this shell never saw.
 *
 * [EditorCaptureOutcome.NoLiveDocument] is not that case. An editor that never
 * presented a document holds nothing, so [shellCopy] — the screen's own
 * `content`, read from disk and then kept in step with every editor `change` —
 * IS the freshest body in existence, and the exit proceeds with it. When the
 * note never finished loading, that body still equals disk, so
 * [commitEditorNavigationSnapshot]'s `content == savedContent` guard makes the
 * write a no-op: leaving ABANDONS the load rather than saving a prefix, which
 * is the only honest thing to do with a document the shell cannot read.
 *
 * 2026-09-01, why this exists: a 50,000-line note with no blank line anywhere
 * blocks the WebView renderer's JS thread for minutes inside `setContent`. The
 * body stayed blank and every Back tap answered "Couldn't save note. Your
 * changes are still pending." — force-quit or Delete Note were the only ways
 * off the screen. iOS states the same rule in `editorExitBody` there
 * (docs/spec/editor.md, "Editor exits").
 */
internal fun editorExitBody(outcome: EditorCaptureOutcome, shellCopy: String): String? =
    when (outcome) {
        is EditorCaptureOutcome.Captured -> outcome.text
        EditorCaptureOutcome.NoLiveDocument -> shellCopy
        EditorCaptureOutcome.NotOurs -> null
    }

internal data class EditorNavigationCommit(
    val savedContent: String,
    val canNavigate: Boolean,
    val disposition: FlushDisposition? = null,
)

internal data class EditorTitleCommit(
    val id: String,
    val isCommitted: Boolean,
)

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

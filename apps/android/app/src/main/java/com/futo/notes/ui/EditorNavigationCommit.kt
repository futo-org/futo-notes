package com.futo.notes.ui

import com.futo.notes.NoteMutationOutcome
import kotlinx.coroutines.withTimeoutOrNull
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

    /**
     * The capture ran out of its deadline while the renderer was still
     * ANSWERING other work — a live JS thread too busy to finish this one read.
     * "I do not know", never "there is nothing there".
     *
     * The distinction from [NoLiveDocument] is the whole point, and it cannot be
     * read off [EditorCaptureOutcome] alone: a renderer wedged inside one long
     * synchronous parse and a renderer streaming a note's tail in idle slices
     * both blow the same deadline. Only a second, trivial round trip issued
     * BEFORE the capture separates them — it comes back between idle slices and
     * never comes back from a wedge. See [captureWithinDeadline].
     */
    data object TimedOut : EditorCaptureOutcome
}

/**
 * The body an exit should commit, given what the capture came back with.
 *
 * `null` means REFUSE the exit — [EditorSession] turns it into
 * [EditorExitFailure.CAPTURE] and the screen stays put. That is reserved for the
 * two answers that leave an edit unaccounted for.
 * [EditorCaptureOutcome.NotOurs]: reading the WebView would hand back another
 * note's text, and leaving on it could discard an edit this shell never saw.
 * [EditorCaptureOutcome.TimedOut]: the editor is alive and busy, so it may be
 * holding exactly the edit the shell has not been told about — a note edited
 * while its tail still streams reports no `change` at all. Refusing costs the
 * user a second Back tap; the retry is cheap, because the first attempt already
 * paid for the remaining parse (the renderer finishes it whether or not this
 * side is still listening).
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
        EditorCaptureOutcome.TimedOut -> null
    }

/**
 * Run [capture] under the exit's deadline, and decide what running out of time
 * MEANS by racing a trivial renderer round trip against it.
 *
 * The deadline is what keeps an exit FINITE: `evaluateJavascript` runs in the
 * renderer, so a JS thread wedged inside one long synchronous parse never calls
 * back at all, and a navigation exit holds the interaction lock while it waits
 * — with no deadline, Back is simply dead (2026-09-01, a 50,000-line single
 * paragraph). Answering that case [EditorCaptureOutcome.NoLiveDocument] is what
 * lets the user leave, and it is safe: the user never had an editable document
 * for that note, so the shell's own copy is still the freshest body there is.
 *
 * But a blown deadline stopped being proof of a wedge once the editor began
 * streaming large notes. Milkdown mounts the FIRST chunk synchronously and
 * appends the rest in idle slices; `initialized` — and with it this shell's
 * `isReady` — arrives after that first chunk, so the user can type into the
 * first viewport while the tail lands. The editor withholds its `change`
 * notification for that whole window (a streaming document is a PREFIX of the
 * note), so the shell's copy does NOT contain that edit, and a capture there
 * makes the editor finish the remaining parse synchronously — which on a big
 * enough note costs more than the deadline. Reading THAT as "no live document"
 * left on the stale copy and dropped the edit.
 *
 * [startLivenessProbe] tells the two apart, and the ORDER is the mechanism:
 * dispatched before [capture], it sits ahead of the capture in the renderer's
 * task queue. A streaming editor yields between idle slices, so the probe comes
 * back in milliseconds even though the capture behind it will not; a wedged
 * renderer never runs either. [rendererAnswered] is therefore read only after
 * the deadline, and only to choose between "busy" and "dead".
 *
 * Extracted from [EditorWebView] so the one decision that matters here is
 * assertable without a WebView.
 */
internal suspend fun captureWithinDeadline(
    deadlineMs: Long,
    startLivenessProbe: () -> Unit,
    rendererAnswered: () -> Boolean,
    capture: suspend () -> EditorCaptureOutcome,
): EditorCaptureOutcome {
    startLivenessProbe()
    val answer = withTimeoutOrNull(deadlineMs) { capture() }
    if (answer != null) return answer
    return if (rendererAnswered()) {
        EditorCaptureOutcome.TimedOut
    } else {
        EditorCaptureOutcome.NoLiveDocument
    }
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

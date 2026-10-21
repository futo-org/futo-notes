package com.futo.notes.ui

import uniffi.futo_notes_ffi.OpenNoteDisposition
import uniffi.futo_notes_ffi.OpenNoteFacts

/**
 * The shell boundary for one open-note reconciliation pass. The session owns
 * serialization, deferred-adoption lifetime, and identity/attachment
 * revalidation; the screen owns gathering its mailbox/disk facts and
 * rendering the Rust engine's disposition.
 */
internal interface OpenNoteEffects {
    fun currentNoteId(): String

    /** This screen still owns the app-lifetime editor WebView. */
    fun isCurrentEditor(): Boolean

    /** Await the latest posted change when the editor has announced an unreported edit. */
    suspend fun awaitCurrent(): EditorCurrent

    /** Complete the background write and baseline record under the autosave lock. */
    suspend fun persistDraft() {}

    suspend fun gatherFacts(noteId: String): OpenNoteFacts

    fun classify(facts: OpenNoteFacts): OpenNoteDisposition

    /** Re-arm a dirty draft after fact gathering canceled its debounce. */
    fun resumeDraftPersistence()

    suspend fun apply(noteId: String, disposition: OpenNoteDisposition)
}

/**
 * Everything an exit needs from the shell. Split this way so the session owns
 * the ORDER and the shell owns the note state: `awaitCurrentBody` is a WebView
 * round-trip for [EditorExit.NAVIGATE] but the live buffer for the other two,
 * and `commitBody` is persist-or-park for navigation but a plain write for move
 * and delete — both differences are the shell's, not the ordering's.
 */
internal interface EditorExitEffects {
    /** Whether the editor attachment this exit was admitted under is current. */
    fun isAttached(): Boolean = true

    /**
     * Leave with NO editor attached. There is nothing to drain and no buffer to
     * commit, so the session hands the exit straight here instead of committing
     * against an unknown body. Only the legacy-WebView notice (github#8) acts on
     * it — it renders no editor at all and its Back must still work; every other
     * detached state means the editor is mid-attach, and the exit is dropped.
     */
    fun exitWithoutEditor() {}

    /**
     * Synchronous work that must happen between the user's tap and the first
     * suspension — canceling the debounced save, dropping focus, blurring the
     * editor. Runs after the latches, so a change arriving from here on is
     * already fenced.
     */
    fun prepare() {}

    /**
     * Suspend until an async producer that has not yet reached [EditorSession.runWork]
     * settles, so the drain below captures its result instead of racing it.
     * [runWork] only serializes work that is ALREADY inside the lock; a picker
     * round trip (image insert) can return and queue its own [EditorSession.runWork]
     * call on a later dispatch than this exit's, so the lock alone does not
     * order them — an exit that reached the lock first would drain the stale
     * body and, seeing it empty and the note untouched, delete it out from
     * under the insert still in flight. Called once, right after [prepare],
     * before the drain.
     *
     * [EditorExit.NAVIGATE] and [EditorExit.MOVE] both override this: neither
     * exit disposes the editor as part of its OWN [perform] the way navigation
     * used to be assumed to, but navigation's `perform` does leave (see
     * `navigateAfterSaving`), so a body it drains stale is gone for good. Move
     * keeps the same attachment open afterward, so racing it costs only a
     * window where the on-disk copy briefly lags the live one — waiting here
     * removes that window instead of leaving it to the ordinary autosave to
     * close.
     *
     * [EditorExit.DELETE] deliberately does NOT override this. It already
     * latches [isClosing] before its own drain runs, which makes ANY
     * [EditorSession.runWork] queued behind it — including a pending image
     * insert — return null without running: the insert's own file write never
     * happens, so nothing is orphaned, and delete is not held up finishing
     * work whose only destination is a note the user just chose to discard.
     */
    suspend fun awaitPendingWork() {}

    /**
     * Stop the debounced body save. Called as the FIRST step inside the drain,
     * so a save already running has finished and only a queued debounce is
     * dropped — canceling it earlier would tear down a write mid-flight.
     */
    suspend fun cancelPendingSave() {}

    /** The freshest body, or null when the editor could not answer. */
    suspend fun awaitCurrentBody(): String?

    /** Persist or park exactly [body]. False = still pending, do not leave. */
    suspend fun commitBody(body: String): Boolean

    /** Commit a pending title rename. False = still pending, do not leave. */
    suspend fun commitTitle(): Boolean = true

    /** The exit's own effect: navigate away, move the file, delete the note. */
    suspend fun perform(): Boolean

    fun onSucceeded() {}

    fun onFailed(failure: EditorExitFailure) {}

    /** A commit after leaving threw; [onFailed] follows with [EditorExitFailure.THREW]. */
    fun onCommitError(error: Exception) {}
}

package com.futo.notes.textfirst

import android.os.SystemClock
import android.util.Log
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import com.futo.notes.storage.GateAccess
import uniffi.futo_notes_ffi.EditorSessionException
import uniffi.futo_notes_ffi.FlushDraftResult
import uniffi.futo_notes_ffi.NativeEditorSession

/**
 * Wait for ordinary vault I/O off the editor thread, then open the whole note
 * there too, so the editor thread stays free to show the quick first screens
 * and queue input meanwhile. The gate stays held until the attachment is
 * installed; callbacks run only after admission ends.
 */
internal fun EditorEngine.open(onOpened: (Throwable?) -> Unit) {
    handler.post { showQuickOpen() }
    val gate = storageGate
    CoroutineScope(Dispatchers.IO).launch {
        var error: Throwable? = null
        val attach: suspend () -> Unit = {
            val began = SystemClock.elapsedRealtimeNanos()
            val opened = store().openEditor(noteId)
            Log.i(EditorEngine.TAG, "openEditor ${(SystemClock.elapsedRealtimeNanos() - began) / 1000} us")
            suspendCoroutine<Unit> { done ->
                if (!handler.post {
                    error = install(opened)
                    done.resume(Unit)
                }) {
                    opened.destroy()
                    error = IllegalStateException("The editor was closed before opening")
                    done.resume(Unit)
                }
            }
        }
        try {
            if (gate == null) attach() else gate.runAccess { attach() }
        } catch (failure: Throwable) {
            Log.e(EditorEngine.TAG, "open $noteId failed", failure)
            error = failure
        }
        // An open that never ran leaves nothing for waiting input to reach.
        if (error != null) handler.post { if (session == null) awaitingOpen = null }
        ui.post { onOpened(error) }
    }
}

/**
 * A long note's first screens from a parse of its first bytes alone, shown
 * read-only before the whole open (Rust guarantees they are the same text
 * and styles). Input that arrives meanwhile waits in [EditorEngine.awaitingOpen].
 */
internal fun EditorEngine.showQuickOpen() {
    if (closed || session != null) return
    val began = SystemClock.elapsedRealtimeNanos()
    val quick = try {
        store().quickOpenEditor(noteId)
    } catch (failure: Exception) {
        Log.w(EditorEngine.TAG, "quick open $noteId failed", failure)
        null
    } ?: return
    val display = quick.projection.text
    // A reader returning deep into the note waits for the whole open, which reaches their line.
    if (openThrough > display.length) return
    mirror.reset(display)
    mirror.selStart = 0; mirror.selEnd = 0
    viewEdits.discontinue()
    quickDisplay = display
    postUpdate(reset = display, edits = emptyList(), windows = listOf(window(quick.projection, tableSpans(quick.tables))))
    Log.i(EditorEngine.TAG, "quick open ${display.length} chars in ${(SystemClock.elapsedRealtimeNanos() - began) / 1000} us")
}

/** Take the opened session on the editor thread and hand the view over to it. */
private fun EditorEngine.install(opened: NativeEditorSession): Throwable? = try {
    if (closed) {
        opened.destroy()
        throw IllegalStateException("The editor is closed")
    }
    val began = SystemClock.elapsedRealtimeNanos()
    session = opened
    fast = FastSession.of(opened)
    rev = opened.revision()
    val display = opened.displayText()
    val quick = quickDisplay
    quickDisplay = null
    mirror.reset(display)
    if (quick != null && display.startsWith(quick)) {
        // The view already shows these screens with these styles; it keeps
        // them, and its caret, and the rest follows in slices.
        tailLength = display.length - quick.length
        if (streaming) streamAfterUi() else postUpdate(emptyList(), emptyList())
    } else {
        if (quick != null) Log.w(EditorEngine.TAG, "quick open of $noteId differs from its whole open; replacing it")
        viewEdits.discontinue()
        // The first screens now, the rest in slices (EditorEngineStream.kt).
        val shown = OpenSlices.sliceEnd(mirror.text, 0, OpenSlices.FIRST_CHARS + openThrough.coerceIn(0, OpenSlices.REACH_BACK_CHARS))
        tailLength = mirror.text.length - shown
        val projection = opened.project(rev, mirror.byteRange(0, shown))
        mirror.selStart = 0; mirror.selEnd = 0
        postUpdate(reset = display.substring(0, shown), edits = emptyList(), windows = listOf(window(projection)), paced = true)
    }
    Log.i(EditorEngine.TAG, "installed ${display.length} chars in ${(SystemClock.elapsedRealtimeNanos() - began) / 1000} us")
    // Taps, keys and commands made while it opened, in order.
    val waiting = awaitingOpen
    awaitingOpen = null
    waiting?.forEach { it() }
    refreshCaretState()
    null
} catch (failure: Throwable) {
    Log.e(EditorEngine.TAG, "open $noteId failed", failure)
    awaitingOpen = null
    failure
}

/** Migration already holds the vault gate. Drain accepted IME work,
 * including marked text, on its owning thread before staging the copy. */
internal fun EditorEngine.checkpointForMigration(done: (Boolean) -> Unit) {
    if (!handler.post {
        val s = session
        var saved = true
        try {
            if (!closed && s != null) {
                if (mirror.overlay != null) commitComposition(null)
                val result = s.checkpoint()
                drainAfterCheckpoint()
                val id = s.noteId()
                ui.post { sink.onCheckpoint(result, id) }
            }
        } catch (e: EditorSessionException) {
            saved = false
            handleFailure(e)
        } finally {
            drainAfterCheckpoint()
        }
        ui.post { done(saved) }
    }) ui.post { done(false) }
}

internal fun EditorEngine.storageAccess(block: () -> Unit): GateAccess =
    storageGate?.tryRunAccess(block) ?: run { block(); GateAccess.RAN }

/** `checkpoint` when [force], else `saveIfDue`; null when nothing was written or it failed. */
internal fun EditorEngine.save(force: Boolean, external: Boolean = false): FlushDraftResult? {
    if (external) reconcilePending = true
    var result: FlushDraftResult? = null
    val access = storageAccess { result = saveUnderGate(force, reconcilePending) }
    if (access != GateAccess.RAN && !closed) {
        handler.removeCallbacks(saveRunnable)
        saveArmed = true
        // Ordinary work (a sync cycle) clears quickly; migration holds until it resolves.
        handler.postDelayed(saveRunnable, if (access == GateAccess.BUSY) EditorEngine.GATE_BUSY_RETRY_MS else 500)
    }
    return result
}

private fun EditorEngine.saveUnderGate(force: Boolean, external: Boolean): FlushDraftResult? {
    val s = session ?: return null
    return try {
        val result = when {
            external -> s.checkpoint()
            force -> if (s.saveDelay() == null) null else s.checkpoint()
            else -> s.saveIfDue()
        } ?: return null
        reconcilePending = false
        // Publish coordinated source/selection before marking this revision saved.
        drainAfterCheckpoint()
        val id = s.noteId()
        ui.post { sink.onCheckpoint(result, id) }
        result
    } catch (e: EditorSessionException) {
        handleFailure(e)
        null
    } finally {
        // A checkpoint can settle composition before a later write fails.
        drainAfterCheckpoint()
        // A failed save reschedules itself in the Store; follow it.
        armSave()
    }
}

internal fun EditorEngine.drainAfterCheckpoint() {
    val s = session ?: return
    for (change in s.takeCoordinatedChanges()) {
        if (change.previousRevision == rev) accept(change) else { reloadFromEngine(); return }
    }
}

/**
 * The rest of the note streams the way an open's does: the next slice comes
 * one UI round trip and a gap after the open completes, never at once.
 */
private fun EditorEngine.streamAfterUi() {
    val generation = renderWork.generation
    renderWork.awaitingUi = true
    ui.post {
        handler.post {
            if (!closed && renderWork.generation == generation) {
                renderWork.awaitingUi = false
                streamTail()
            }
        }
    }
}

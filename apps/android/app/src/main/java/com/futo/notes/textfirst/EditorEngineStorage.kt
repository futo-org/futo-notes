package com.futo.notes.textfirst

import android.util.Log
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import com.futo.notes.storage.GateAccess
import uniffi.futo_notes_ffi.EditorSessionException
import uniffi.futo_notes_ffi.FlushDraftResult

/** Wait for ordinary vault I/O off the editor thread. The gate stays held
 * until the attachment is ready; callbacks run only after admission ends. */
internal fun EditorEngine.open(onOpened: (Throwable?) -> Unit) {
    val gate = storageGate
    if (gate == null) {
        handler.post {
            val error = openAttachment()
            ui.post { onOpened(error) }
        }
        return
    }
    CoroutineScope(Dispatchers.IO).launch {
        var error: Throwable? = null
        try {
            gate.runAccess {
                suspendCoroutine<Unit> { done ->
                    if (!handler.post {
                        error = openAttachment()
                        done.resume(Unit)
                    }) {
                        error = IllegalStateException("The editor was closed before opening")
                        done.resume(Unit)
                    }
                }
            }
        } catch (failure: Throwable) {
            error = failure
        }
        ui.post { onOpened(error) }
    }
}

private fun EditorEngine.openAttachment(): Throwable? = try {
    check(!closed) { "The editor is closed" }
    val opened = store().openEditor(noteId)
    session = opened
    fast = FastSession.of(opened)
    rev = opened.revision()
    val display = opened.displayText()
    mirror.reset(display)
    viewEdits.discontinue()
    // The first screens now, the rest in slices (EditorEngineStream.kt).
    val shown = OpenSlices.sliceEnd(mirror.text, 0, OpenSlices.FIRST_CHARS + openThrough.coerceIn(0, OpenSlices.REACH_BACK_CHARS))
    tailLength = mirror.text.length - shown
    val projection = opened.project(rev, mirror.byteRange(0, shown))
    mirror.selStart = 0; mirror.selEnd = 0
    postUpdate(reset = display.substring(0, shown), edits = emptyList(), windows = listOf(window(projection)), paced = true)
    refreshCaretState()
    null
} catch (failure: Throwable) {
    Log.e(EditorEngine.TAG, "open $noteId failed", failure)
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

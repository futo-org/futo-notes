package com.futo.notes.textfirst

import android.util.Log
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import uniffi.futo_notes_ffi.EditorByteRange
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
    val projection = opened.project(rev, EditorByteRange(0u, mirror.utf8Length.toULong()))
    mirror.selStart = 0; mirror.selEnd = 0
    postUpdate(reset = display, edits = emptyList(), windows = listOf(window(projection)))
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

internal fun EditorEngine.storageAccess(block: () -> Unit): Boolean =
    storageGate?.tryRunAccess(block) ?: run { block(); true }

/** `checkpoint` when [force], else `saveIfDue`; null when nothing was written or it failed. */
internal fun EditorEngine.save(force: Boolean): FlushDraftResult? {
    var result: FlushDraftResult? = null
    if (!storageAccess { result = saveUnderGate(force) } && !closed) {
        handler.removeCallbacks(saveRunnable)
        saveArmed = true
        handler.postDelayed(saveRunnable, 500)
    }
    return result
}

private fun EditorEngine.saveUnderGate(force: Boolean): FlushDraftResult? {
    val s = session ?: return null
    return try {
        val result = when {
            force -> if (s.saveDelay() == null) null else s.checkpoint()
            else -> s.saveIfDue()
        } ?: return null
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

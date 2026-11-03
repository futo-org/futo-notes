package com.futo.notes.textfirst

import android.util.Log
import uniffi.futo_notes_ffi.EditorByteRange
import uniffi.futo_notes_ffi.NativeEditorSession
import uniffi.futo_notes_ffi.EditorSessionException
import uniffi.futo_notes_ffi.FlushDraftResult

internal fun EditorEngine.open(onOpened: (Throwable?) -> Unit) = handler.post {
    try {
        var attachment: NativeEditorSession? = null
        check(storageAccess { attachment = store().openEditor(noteId) }) { "Storage access is paused for migration" }
        val opened = checkNotNull(attachment)
        session = opened
        fast = FastSession.of(opened)
        rev = opened.revision()
        val display = opened.displayText()
        mirror.reset(display)
        val projection = opened.project(rev, EditorByteRange(0u, mirror.utf8Length.toULong()))
        mirror.selStart = 0; mirror.selEnd = 0
        postUpdate(reset = display, edits = emptyList(), windows = listOf(window(projection)))
        ui.post { onOpened(null) }
        refreshCaretState()
    } catch (e: Throwable) {
        Log.e(EditorEngine.TAG, "open $noteId failed", e)
        ui.post { onOpened(e) }
    }
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


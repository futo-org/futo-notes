package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorSessionException
import uniffi.futo_notes_ffi.FlushDraftResult

/** `checkpoint` when [force], else `saveIfDue`; null when nothing was written or it failed. */
internal fun EditorEngine.save(force: Boolean): FlushDraftResult? {
    val s = session ?: return null
    return try {
        val result = when {
            force -> if (s.saveDelay() == null) null else s.checkpoint()
            else -> s.saveIfDue()
        } ?: return null
        val id = s.noteId()
        ui.post { sink.onCheckpoint(result, id) }
        drainAfterCheckpoint()
        result
    } catch (e: EditorSessionException) {
        handleFailure(e)
        null
    } finally {
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


package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorSessionException

/** Begin an asynchronous image insertion; the claim goes back to [insertImage]. */
internal fun EditorEngine.imageClaim(deliver: (ULong?) -> Unit) {
    val posted = handler.post {
        var claim: ULong? = null
        try {
            if (!closed && session != null && storageGate?.isMigrationStarted != true) {
                claim = session?.imageClaim()
            }
        } catch (e: EditorSessionException) {
            handleFailure(e)
        } finally {
            ui.post { deliver(claim) }
        }
    }
    if (!posted) ui.post { deliver(null) }
}

internal fun EditorEngine.insertImage(claim: ULong, reference: String, done: (Boolean) -> Unit) {
    // This command holds a vault attachment operation open until its answer.
    // Every path, including stale/deleted sessions and a retired thread,
    // must answer; guarded() alone reports errors without a completion.
    val posted = handler.post {
        var inserted = false
        try {
            if (!closed && session != null && storageGate?.isMigrationStarted != true) {
                if (mirror.overlay != null) commitComposition(null)
                val change = session?.insertImage(rev, claim, reference, "")
                if (change != null) {
                    inserted = true
                    accept(change)
                }
            }
        } catch (e: EditorSessionException) {
            handleFailure(e)
        } finally {
            ui.post { done(inserted) }
        }
    }
    if (!posted) ui.post { done(false) }
}

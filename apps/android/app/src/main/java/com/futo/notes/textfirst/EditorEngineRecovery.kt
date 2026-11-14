package com.futo.notes.textfirst

import android.util.Log
import uniffi.futo_notes_ffi.EditorSessionException

// What the editor thread does when the engine refuses or fails an edit, and
// the reload that brings the mirror and the view back to the engine's text.

internal fun EditorEngine.handleFailure(e: EditorSessionException) {
    when (e) {
        is EditorSessionException.UnrepresentableFormat,
        is EditorSessionException.CompositionActive,
        is EditorSessionException.InvalidRange,
        is EditorSessionException.InvalidText -> {
            // A refused command changes nothing (lists.md, interpretation
            // spec); the keyboard may have assumed otherwise.
            Log.i(EditorEngine.TAG, "refused: $e")
            ui.post { sink.onImeReset() }
            postUpdate(emptyList(), emptyList())
        }
        is EditorSessionException.StaleRevision -> {
            Log.e(EditorEngine.TAG, "stale revision on the editor thread — mirror out of step", e)
            reloadFromEngine()
        }
        else -> {
            Log.e(EditorEngine.TAG, "editor failure", e)
            ui.post { sink.onFailure(e); sink.onImeReset() }
            postUpdate(emptyList(), emptyList())
        }
    }
}

internal fun EditorEngine.reloadFromEngine() {
    val s = session ?: return
    stopStreaming()
    mirror.overlay = null
    try { s.composition()?.let { s.cancelComposition(s.revision()) } } catch (_: EditorSessionException) {}
    rev = s.revision()
    val display = s.displayText()
    mirror.reset(display)
    viewEdits.discontinue()
    mirror.selStart = mirror.selStart.coerceIn(0, mirror.text.length); mirror.selEnd = mirror.selEnd.coerceIn(mirror.selStart, mirror.text.length)
    resetViewProgressively()
    ui.post { sink.onImeReset() }
}

package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorSessionException
import uniffi.futo_notes_ffi.FlushDraftResult

internal interface EngineSink {
    fun onImeState(state: EngineImeState) {}
    fun onCell(update: CellUpdate?) {}
    fun onUpdate(update: UiUpdate)
    fun onCompletion(draft: CompletionDraft?) {}
    fun onFind(snapshot: FindSnapshot) {}
    fun onCaretState(state: CaretState)
    /** Explicit external identity was adopted, even if its following save fails. */
    fun onAttachmentId(noteId: String)
    /** A Markdown save landed; [noteId] is the attachment's identity after it (a park moves it). */
    fun onCheckpoint(result: FlushDraftResult, noteId: String)
    /** A failed save does not pause input: the Store retries it on its own schedule. */
    fun onFailure(error: EditorSessionException)
    /** The keyboard's idea of the text is now wrong (a refused edit); restart its connection. */
    fun onImeReset()
}

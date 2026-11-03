package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorWikilinkCompletion

/** The canonical run plus the attachment that supplied it. No host parsing or filtering. */
internal data class CompletionDraft(val owner: EditorEngine, val value: EditorWikilinkCompletion)

internal fun EditorEngine.completionDraft(deliver: (CompletionDraft?) -> Unit) = command(onUnavailable = { deliver(null) }) {
    val found = currentCompletion()
    ui.post { deliver(found) }
}

internal fun EditorEngine.currentCompletion(): CompletionDraft? {
    val found = session?.wikilinkCompletion(rev)
    if (found == null) {
        dismissedCompletionStart = null
        return null
    }
    if (dismissedCompletionStart == found.range.start) return null
    return CompletionDraft(this, found)
}

internal fun EditorEngine.refreshCompletion() {
    val found = currentCompletion()
    ui.post { sink.onCompletion(found) }
}

internal fun EditorEngine.dismissCompletion(draft: CompletionDraft) = command {
    val found = session?.wikilinkCompletion(rev)
    if (draft.owner === this && found?.range?.start == draft.value.range.start) {
        dismissedCompletionStart = found.range.start
        ui.post { sink.onCompletion(null) }
    }
}

internal fun EditorEngine.acceptCompletion(draft: CompletionDraft, noteId: String, done: (Boolean) -> Unit) = command(onUnavailable = { done(false) }) {
    var applied = false
    try {
        if (draft.owner === this && mirror.overlay == null && draft.value.revision == rev &&
            draft.value.candidates.any { it.noteId == noteId }) {
            val found = session?.wikilinkCompletion(rev)
            if (found == draft.value && dismissedCompletionStart != found.range.start) {
                session?.acceptWikilinkCompletion(rev, found.range, found.query, noteId)?.let {
                    accept(it)
                    applied = true
                }
            }
        }
    } finally { ui.post { done(applied) } }
}

/** A vault change refreshes the delivered catalog once, never per completion request. */
internal fun EditorEngine.refreshCompletionNoteIds() = command {
    val change = session?.refreshNoteIds() ?: return@command
    lastProjection = null
    if (change.projections.isNotEmpty()) postUpdate(emptyList(), change.projections.map(::window))
}

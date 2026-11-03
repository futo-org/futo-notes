package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorByteRange

/** Revision-bound dialog snapshot; no edits occur until the user submits. */
internal data class LinkDraft(
    val owner: EditorEngine,
    val revision: ULong,
    val range: EditorByteRange,
    val label: String,
    val destination: String,
    val existing: Boolean,
)

/** Inspect only on demand, after queued keyboard input; never on a keystroke. */
internal fun EditorEngine.linkDraft(deliver: (LinkDraft?) -> Unit) = command(onUnavailable = { deliver(null) }) {
    var draft: LinkDraft? = null
    try {
        if (mirror.overlay != null) commitComposition(null)
        val range = mirror.byteRange(minOf(selStart, selEnd), maxOf(selStart, selEnd))
        val link = session?.inspectLink(rev, range)
        val target = link?.range ?: range
        draft = LinkDraft(this, rev, target,
            text.subSequence(mirror.toUtf16(target.start.toInt()), mirror.toUtf16(target.end.toInt())).toString(),
            link?.destination ?: "", link != null)
    } finally {
        val result = draft
        ui.post { deliver(result) }
    }
}

internal fun EditorEngine.removeLink(draft: LinkDraft, done: (Boolean) -> Unit) = command(onUnavailable = { done(false) }) {
    var applied = false
    try {
        if (draft.owner === this && draft.revision == rev && mirror.overlay == null) {
            session?.setLink(rev, draft.range, "")?.let(::accept)
            applied = true
        }
    } finally {
        ui.post { done(applied) }
    }
}

internal fun EditorEngine.editLink(draft: LinkDraft, label: String, destination: String, done: (Boolean) -> Unit) = command(onUnavailable = { done(false) }) {
    var applied = false
    try {
        if (draft.owner === this && draft.revision == rev && mirror.overlay == null) {
            session?.editLink(rev, draft.range, label, destination)?.let(::accept)
            applied = true
        }
    } finally {
        ui.post { done(applied) }
    }
}

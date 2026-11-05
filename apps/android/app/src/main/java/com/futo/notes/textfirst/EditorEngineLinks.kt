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
internal fun EditorEngine.linkDraft(deliver: (LinkDraft?) -> Unit) = command(RefusedEdit.EDIT, onUnavailable = { deliver(null) }) {
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

/** A command whose caller waits for "applied": [block] says so, and the answer is delivered even if it throws.
 * A refusal toasts as [action]; the link dialog passes none, since it shows its own failure. */
internal fun EditorEngine.ackedCommand(done: (Boolean) -> Unit, action: RefusedEdit? = null, block: () -> Boolean) = command(action, onUnavailable = { done(false) }) {
    var applied = false
    try { applied = block() } finally { ui.post { done(applied) } }
}

internal fun EditorEngine.removeLink(draft: LinkDraft, done: (Boolean) -> Unit) = ackedCommand(done) {
    val current = draft.owner === this && draft.revision == rev && mirror.overlay == null
    if (current) session?.setLink(rev, draft.range, "")?.let(::accept)
    current
}

internal fun EditorEngine.editLink(draft: LinkDraft, label: String, destination: String, done: (Boolean) -> Unit) = ackedCommand(done) {
    val current = draft.owner === this && draft.revision == rev && mirror.overlay == null
    if (current) session?.editLink(rev, draft.range, label, destination)?.let(::accept)
    current
}

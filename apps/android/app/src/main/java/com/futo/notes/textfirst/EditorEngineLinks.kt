package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorByteRange

/** Revision-bound dialog snapshot; no edits occur until the user submits. */
internal data class LinkDraft(
    val owner: EditorEngine,
    val revision: ULong,
    val range: EditorByteRange,
    /** The engine's `link_label`; null where a label edit would write nothing (across table cells): destination only. */
    val label: String?,
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
        draft = LinkDraft(this, rev, target, session?.linkLabel(rev, range), link?.destination ?: "", link != null)
    } finally {
        val result = draft
        ui.post { deliver(result) }
    }
}

/** A command whose caller waits for "applied": [block] says so, and the answer is delivered even if it throws. */
internal fun EditorEngine.ackedCommand(done: (Boolean) -> Unit, block: () -> Boolean) = command(onUnavailable = { done(false) }) {
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
    // A typed address is saved as desktop saves it (`example.com` becomes `https://example.com`).
    if (current) session?.let {
        val normalized = it.normalizeLinkDestination(destination)
        if (draft.label == null) it.setLink(rev, draft.range, normalized) else it.editLink(rev, draft.range, label, normalized)
    }?.let(::accept)
    current
}

/** The target the engine parsed for the wikilink drawn over [start, end) (what a note it names is called). */
internal fun EditorEngine.wikilinkTarget(viewSeq: Int, start: Int, end: Int, deliver: (String) -> Unit) = command {
    val s = session ?: return@command
    // The view may show text an edit since has changed: its offsets are mapped to the engine's own, as a tap's are.
    val (a, b) = viewEdits.map(viewSeq, start, end) ?: return@command
    val tapped = mirror.byteRange(a, b)
    // The projection holds every wikilink of the range's paragraph, not only the tapped one.
    val target = s.project(rev, tapped).wikilinks.firstOrNull { it.range.start < tapped.end && it.range.end > tapped.start }?.target
    if (target != null) ui.post { deliver(target) }
}

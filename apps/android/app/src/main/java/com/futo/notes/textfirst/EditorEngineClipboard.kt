package com.futo.notes.textfirst

internal fun EditorEngine.paste(markdown: String) = command {
    if (mirror.overlay != null) commitComposition(null)
    keyed = true
    try { session?.pasteMarkdown(rev, mirror.byteRange(mirror.selStart, mirror.selEnd), markdown)?.let(::accept) } finally { keyed = false }
}

/**
 * [deliver] runs on this thread and says whether the clipboard took the text. A cut
 * removes the selection only after it did: the system clipboard refuses a large one.
 */
internal fun EditorEngine.copy(cut: Boolean, deliver: (String) -> Boolean) = command {
    if (mirror.overlay != null) commitComposition(null)
    val s = session ?: return@command
    // An empty block selected as one object is a collapsed range that is still something to copy.
    if (mirror.selStart == mirror.selEnd && mirror.selectedBlock == null) return@command
    val range = mirror.byteRange(mirror.selStart, mirror.selEnd)
    if (!deliver(s.copyMarkdown(rev, range)) || !cut) return@command
    s.cutMarkdown(rev, range).change?.let(::accept)
}

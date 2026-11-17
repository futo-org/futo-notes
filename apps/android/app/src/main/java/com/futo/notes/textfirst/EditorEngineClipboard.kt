package com.futo.notes.textfirst

internal fun EditorEngine.paste(markdown: String) = command {
    if (mirror.overlay != null) commitComposition(null)
    session?.pasteMarkdown(rev, mirror.byteRange(mirror.selStart, mirror.selEnd), markdown)?.let(::accept)
}

/**
 * [deliver] runs on this thread and says whether the clipboard took the text. A cut
 * removes the selection only after it did: the system clipboard refuses a large one.
 */
internal fun EditorEngine.copy(cut: Boolean, deliver: (String) -> Boolean) = command {
    if (mirror.overlay != null) commitComposition(null)
    val s = session ?: return@command
    if (mirror.selStart == mirror.selEnd) return@command
    val range = mirror.byteRange(mirror.selStart, mirror.selEnd)
    if (!deliver(s.copyMarkdown(rev, range)) || !cut) return@command
    s.cutMarkdown(rev, range).change?.let(::accept)
}

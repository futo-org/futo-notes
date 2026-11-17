package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.EditorCodeBlockHeader
import uniffi.futo_notes_ffi.EditorSessionException
import uniffi.futo_notes_ffi.EditorUtf16Range

/** A tap on a block's header: select the code block whose code shows at [offset] as one object. */
internal fun EditorEngine.selectCodeBlock(offset: Int) = command {
    if (mirror.overlay != null) commitComposition(null)
    val s = session ?: return@command
    applySelectionChange(s.selectCodeBlock(rev, mirror.toByte(offset).toULong()))
    postUpdate(emptyList(), emptyList())
}

/** An "add a line" press: [side] opens an empty line before or after the block whose code starts at [offset]. */
internal fun EditorEngine.openCodeBlockLine(offset: Int, side: EditorBlockCommand) = command {
    if (mirror.overlay != null) commitComposition(null)
    val s = session ?: return@command
    s.blockCommandUtf16(rev, EditorUtf16Range(offset.toULong(), offset.toULong()), side)?.let(::accept)
}

/** The code of the block from [start] to [end], fences left out, for [deliver] on this thread. */
internal fun EditorEngine.copyCodeBlock(start: Int, end: Int, deliver: (String) -> Boolean) = command {
    if (mirror.overlay != null) commitComposition(null)
    val s = session ?: return@command
    val length = mirror.text.length
    deliver(s.copyMarkdown(rev, mirror.byteRange(start.coerceIn(0, length), end.coerceIn(0, length))))
}

/**
 * A header field's keystroke: write the block's [language] and [name] (fenced-code.md
 * `set_code_block_header`). A value the fence cannot hold is refused and the fence keeps its
 * last good one; [onRefused] hears that on the UI thread, so the field can keep its text.
 */
internal fun EditorEngine.writeCodeBlockHeader(offset: Int, language: String, name: String, onRefused: () -> Unit) = command {
    if (mirror.overlay != null) commitComposition(null)
    val s = session ?: return@command
    val header = EditorCodeBlockHeader(mirror.toByte(offset).toULong(), language, name)
    try {
        s.setCodeBlockHeader(rev, header)?.let(::accept)
    } catch (e: EditorSessionException.InvalidText) {
        ui.post(onRefused)
    }
}

package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorBlockCommand
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

package com.futo.notes.textfirst

/** A tap on a block's header: select the code block whose code shows at [offset] as one object. */
internal fun EditorEngine.selectCodeBlock(offset: Int) = command {
    if (mirror.overlay != null) commitComposition(null)
    val s = session ?: return@command
    applySelectionChange(s.selectCodeBlock(rev, mirror.toByte(offset).toULong()))
    postUpdate(emptyList(), emptyList())
}

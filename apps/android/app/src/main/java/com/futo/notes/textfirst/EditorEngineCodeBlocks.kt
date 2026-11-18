package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.EditorCodeBlockHeader
import uniffi.futo_notes_ffi.EditorParagraphKey
import uniffi.futo_notes_ffi.EditorSessionException
import uniffi.futo_notes_ffi.EditorStyleSpan
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
/** The copy glyph: the code of the block whose code starts at [codeStart], as the engine holds it now. */
internal fun EditorEngine.copyCodeBlock(codeStart: Int, deliver: (String) -> Boolean) = command {
    if (mirror.overlay != null) commitComposition(null)
    val s = session ?: return@command
    val length = mirror.text.length
    val at = codeStart.coerceIn(0, length)
    val block = s.stylePlan(rev, mirror.byteRange(at, minOf(at + 1, length)))
        .filterIsInstance<EditorStyleSpan.CodeBlock>().firstOrNull { it.start.toInt() <= at && at <= it.end.toInt() } ?: return@command
    deliver(s.copyMarkdown(rev, mirror.byteRange(block.start.toInt(), block.end.toInt())))
}

/**
 * A header field's keystroke: write the block's [language] and [name] (fenced-code.md
 * `set_code_block_header`). A value the fence cannot hold is refused and the fence keeps its last good one; the field
 * keeps showing what was typed until it closes, and the drawn label then shows the fence's value.
 */
internal fun EditorEngine.writeCodeBlockHeader(offset: Int, language: String, name: String) = command {
    if (mirror.overlay != null) commitComposition(null)
    val s = session ?: return@command
    val header = EditorCodeBlockHeader(mirror.toByte(offset).toULong(), language, name)
    try {
        s.setCodeBlockHeader(rev, header)?.let(::accept)
    } catch (_: EditorSessionException.InvalidText) {
    }
}


/**
 * Ctrl+Enter (below) or Ctrl+Shift+Enter (above), on the editor thread: the caret goes to the line's end, or its start
 * (after its indent in code, so the engine's Enter carries the indent to both lines), and the engine's Enter makes the
 * line; above, the caret then stays on the line it opened. Read from the engine's own text and caret, so a view update
 * in flight cannot move it. One engine command would be better (asked of the engine's owner).
 */
internal fun EditorEngine.openLine(above: Boolean, inCode: Boolean) = input {
    if (session == null) return@input
    if (mirror.overlay != null) commitComposition(null)
    val text = mirror.text
    val caret = mirror.selStart
    if (caret != mirror.selEnd) return@input
    var lineStart = caret
    while (lineStart > 0 && text[lineStart - 1] != '\n') lineStart--
    var lineEnd = caret
    while (lineEnd < text.length && text[lineEnd] != '\n') lineEnd++
    var indentEnd = lineStart
    while (inCode && indentEnd < lineEnd && (text[indentEnd] == ' ' || text[indentEnd] == '\t')) indentEnd++
    val at = if (above) indentEnd else lineEnd
    select(at, at, fromView = false)
    key(EditorParagraphKey.ENTER)
    if (above) select(at, at, fromView = false)
}

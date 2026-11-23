package com.futo.notes.textfirst

import android.text.Editable

/**
 * Apply an engine [edit] whose rows the update restyles, moving the renderer's spans around it with the text: none
 * stretched over the inserted text, none of the replaced text's left behind. Android's span flags, inclusive for
 * composition, grew the row span after an insertion at its start over the inserted rows (a task drawn without its
 * box after Enter, round 3 N6) and collapsed the replaced rows' spans onto the edit's edge (a paragraph drawn as code
 * after a block moved away, N5), outside the windows that restyle the edit's own rows.
 */
internal fun Editable.replaceKeepingRowSpans(edit: TextEdit) {
    val start = edit.start
    val end = edit.end
    val delta = edit.text.length - (end - start)
    val around = getSpans(start, end, TfSpan::class.java).mapNotNull { span ->
        val s = getSpanStart(span)
        if (s < 0) null else SpanAt(span, s, getSpanEnd(span), getSpanFlags(span))
    }
    replace(start, end, edit.text)
    for (at in around) {
        val (s, en) = when {
            at.start < start && at.end > end -> continue // holds the edit: it grows and shrinks with it
            at.end <= start -> at.start to at.end
            at.start >= end -> at.start + delta to at.end + delta
            at.start < start -> at.start to start
            at.end > end -> start + edit.text.length to at.end + delta
            else -> { removeSpan(at.span); continue }
        }
        if (s >= en && at.start < at.end) removeSpan(at.span) else if (getSpanStart(at.span) != s || getSpanEnd(at.span) != en) setSpan(at.span, s, en, at.flags)
    }
}

private class SpanAt(val span: TfSpan, val start: Int, val end: Int, val flags: Int)

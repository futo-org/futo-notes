package com.futo.notes.textfirst

/**
 * A cell edit carries the canonical table's complete styles. Keep that metadata
 * authoritative, but reflow just the edited row when every other span is equal
 * after the text shift. Structural changes, partial tables and composition use
 * the original window. No Markdown interpretation happens here.
 */
internal fun TextFirstEditText.tableEditWindows(update: UiUpdate): List<StyleWindow> {
    val original = update.windows
    val window = original.singleOrNull() ?: return original
    if (update.marked != null || window.specs.isEmpty() ||
        window.specs.any { it !is SpanSpec.TableRow && it !is SpanSpec.TableDelimiter }) return original
    val edit = update.edits.singleOrNull() ?: return original
    val e = editableText
    if (edit.start !in 0..edit.end || edit.end >= e.length || edit.text.contains('\n')) return original
    for (i in edit.start until edit.end) if (e[i] == '\n') return original
    val row = e.getSpans(edit.start, edit.end, TfTableRow::class.java).singleOrNull {
        e.getSpanStart(it) <= edit.start && e.getSpanEnd(it) >= edit.end &&
            edit.start < e.getSpanEnd(it)
    } ?: return original
    val start = e.getSpanStart(row)
    val end = e.getSpanEnd(row)
    val delta = edit.text.length - (edit.end - edit.start)
    val oldEnd = window.end - delta
    if (window.start > start || oldEnd < end || oldEnd >= e.length) return original
    val wanted = window.specs.associateBy { it.start to it.end }.toMutableMap()
    if (wanted.size != window.specs.size) return original
    val changed = wanted[start to end + delta] as? SpanSpec.TableRow ?: return original
    for (span in e.getSpans(window.start, oldEnd, TfSpan::class.java)) {
        val s = e.getSpanStart(span)
        val en = e.getSpanEnd(span)
        if (s != en && (en <= window.start || s >= oldEnd)) continue
        if (s < window.start || en > oldEnd) return original
        val shift = if (s >= edit.end && span !== row) delta else 0
        val nextEnd = if (span === row) en + delta else en + shift
        val spec = wanted.remove(s + shift to nextEnd) ?: return original
        if (span !== row && !spans.matches(spec, span)) return original
    }
    if (wanted.isNotEmpty()) return original
    return listOf(StyleWindow(changed.start, changed.end, listOf(changed)))
}

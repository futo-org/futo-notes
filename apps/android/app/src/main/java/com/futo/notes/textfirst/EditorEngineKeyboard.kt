package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorInputAction
import uniffi.futo_notes_ffi.EditorParagraphKey
import uniffi.futo_notes_ffi.EditorUtf16Range
import uniffi.futo_notes_ffi.EditorUtf16Replacement

// Keyboard input for [EditorEngine]: called on the editor thread by the input
// connection. Marked text is an engine-owned overlay (interpretation spec,
// composition lines); the mirror shows it so the keyboard reads what it wrote.


internal fun EditorEngine.replace(start: Int, end: Int, value: String, action: EditorInputAction) {
    if (session == null) return
    accept(checkNotNull(fast).replace(rev, start, end, value, action))
}

internal fun EditorEngine.imeCommit(value: String) = input(RefusedEdit.TEXT) {
    val o = mirror.overlay
    when {
        o != null -> commitComposition(value)
        value == "\n" -> key(EditorParagraphKey.ENTER)
        else -> replace(mirror.selStart, mirror.selEnd, value, EditorInputAction.TYPING)
    }
}

internal fun EditorEngine.imeSetComposing(value: String) = input(RefusedEdit.TEXT) {
    val s = session ?: return@input
    val o = mirror.overlay
    if (o == null) {
        val start = mirror.selStart; val end = mirror.selEnd
        s.composeUtf16(rev, EditorUtf16Range(start.toULong(), end.toULong()), units(value))
        val opened = DisplayMirror.Overlay(start, mirror.text.substring(start, end), mirror.text.substring(start, end))
        mirror.overlay = opened
        setMarked(opened, value)
    } else {
        s.composeUtf16(rev, EditorUtf16Range(o.start.toULong(), (o.start + o.original.length).toULong()), units(value))
        setMarked(o, value)
    }
}

internal fun EditorEngine.imeSetComposingRegion(start: Int, end: Int) = input(RefusedEdit.EDIT) {
    val s = session ?: return@input
    if (mirror.overlay != null) commitComposition(null)
    val a = minOf(start, end).coerceIn(0, mirror.text.length)
    val b = maxOf(start, end).coerceIn(0, mirror.text.length)
    val existing = mirror.text.substring(a, b)
    s.composeUtf16(rev, EditorUtf16Range(a.toULong(), b.toULong()), units(existing))
    mirror.overlay = DisplayMirror.Overlay(a, existing, existing)
    postUpdate(edits = emptyList(), windows = emptyList())
}

internal fun EditorEngine.imeFinishComposing() = input(RefusedEdit.TEXT) {
    if (mirror.overlay != null) commitComposition(null)
}

internal fun EditorEngine.imeDeleteSurrounding(before: Int, after: Int) = input(RefusedEdit.EDIT) {
    if (mirror.selStart == mirror.selEnd && mirror.overlay == null) {
        if (after == 0 && before > 0 && mirror.selStart - before == mirror.previousGrapheme(mirror.selStart)) {
            return@input key(EditorParagraphKey.BACKSPACE)
        }
        if (before == 0 && after > 0 && mirror.selEnd + after == mirror.nextGrapheme(mirror.selEnd)) {
            return@input key(EditorParagraphKey.DELETE)
        }
    }
    val a = (mirror.selStart - before).coerceAtLeast(0)
    val b = (mirror.selEnd + after).coerceAtMost(mirror.text.length)
    if (mirror.selStart == mirror.selEnd) {
        if (a < b) replace(a, b, "", EditorInputAction.TYPING)
    } else {
        val s = session ?: return@input
        val pieces = listOf(a to mirror.selStart, mirror.selEnd to b).filter { it.first < it.second }
        if (pieces.isEmpty()) return@input
        val change = s.replaceManyUtf16(rev, pieces.map { (x, y) ->
            EditorUtf16Replacement(EditorUtf16Range(x.toULong(), y.toULong()), emptyList())
        })
        accept(change)
    }
}

internal fun EditorEngine.imeSetSelection(start: Int, end: Int) = input(RefusedEdit.EDIT) {
    select(start, end, fromView = false)
}

internal fun EditorEngine.key(key: EditorParagraphKey) = input(RefusedEdit.forKey(key)) {
    if (session == null) return@input
    if (mirror.overlay != null) commitComposition(null)
    val intent = if (key == EditorParagraphKey.BACKSPACE) EditorParagraphKey.BACKSPACE_JOINING_HEADING else key
    val change = checkNotNull(fast).paragraphKey(rev, mirror.selStart, mirror.selEnd, intent)
    if (change != null) accept(change)
}


internal fun EditorEngine.commitComposition(value: String?) {
    val s = session ?: return
    val o = mirror.overlay ?: return
    val change = s.commitCompositionUtf16(rev, value?.let(::units))
    if (change != null) {
        accept(change)
    } else {
        // Nothing changed: the committed text equals what was there.
        val edits = ArrayList<TextEdit>(1)
        mirror.replace(o.start, o.start + o.marked.length, o.original, edits)
        mirror.overlay = null
        mirror.selStart = o.start + o.original.length; mirror.selEnd = mirror.selStart
        if (edits.any { it.text.length > OpenSlices.NEXT_CHARS * 2 || it.end > tailStart() }) resetViewProgressively(edits)
        else postUpdate(edits, listOf(projectWindow(o.start, (o.start + o.original.length).coerceAtMost(tailStart()))))
    }
    streamTail(0)
}

internal fun EditorEngine.setMarked(o: DisplayMirror.Overlay, value: String) {
    val shown = tailStart()
    val edits = ArrayList<TextEdit>(1)
    mirror.replace(o.start, o.start + o.marked.length, value, edits)
    o.marked = value
    mirror.selStart = o.start + value.length; mirror.selEnd = mirror.selStart
    // Marked text is provisional. Clip only its renderer delta, never the
    // keyboard's full-document coordinates or the engine's original text.
    val visible = edits.mapNotNull { edit ->
        if (edit.start > shown) null else TextEdit(edit.start, minOf(edit.end, shown), edit.text)
    }
    val newShown = shown + visible.sumOf { it.text.length - (it.end - it.start) }
    tailLength = mirror.text.length - newShown
    if (visible.any { it.text.length > OpenSlices.NEXT_CHARS * 2 }) resetMarkedView(visible)
    else postUpdate(visible, emptyList())
}

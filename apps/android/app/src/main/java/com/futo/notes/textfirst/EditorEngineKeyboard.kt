package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorInlineFormat
import uniffi.futo_notes_ffi.EditorInputAction
import uniffi.futo_notes_ffi.EditorMarkedRun
import uniffi.futo_notes_ffi.EditorParagraphKey
import uniffi.futo_notes_ffi.EditorUtf16Range
import uniffi.futo_notes_ffi.EditorUtf16Replacement

// Keyboard input for [EditorEngine]: called on the editor thread by the input
// connection. Marked text is an engine-owned overlay (interpretation spec,
// composition lines); the mirror shows it so the keyboard reads what it wrote,
// and the view draws it in the formats the engine says it will commit with.


internal fun EditorEngine.replace(start: Int, end: Int, value: String, action: EditorInputAction) {
    if (session == null) return
    accept(checkNotNull(fast).replace(rev, start, end, value, action))
}

internal fun EditorEngine.imeCommit(value: String) = input {
    val o = mirror.overlay
    val typedAfter = pairKeyAfterCorrection(value)
    when {
        // A keyboard's correction can carry the pair key the user typed after the word ("world*"): the word commits,
        // then that key is typed as a key, so it still steps out of or into a pair (pairing verifier, FUTO Keyboard).
        o != null && typedAfter != null -> {
            commitComposition(value.dropLast(typedAfter.length))
            replace(mirror.selStart, mirror.selEnd, typedAfter, EditorInputAction.PAIRED_TYPING)
        }
        o != null -> commitComposition(value)
        value == "\n" -> key(EditorParagraphKey.ENTER)
        else -> replace(mirror.selStart, mirror.selEnd, value, typedAction(value))
    }
}

/** The pair key a composition's commit ends with, after at least one other character; null otherwise. */
private fun pairKeyAfterCorrection(value: String): String? {
    if (value.codePointCount(0, value.length) < 2) return null
    val last = value.substring(value.offsetByCodePoints(value.length, -1))
    return last.takeIf { it in PAIR_KEYS }
}

/** The characters paired typing reads (paired-typing.md); any other character types as typing. */
private val PAIR_KEYS = setOf("`", "*", "~", "[", "]")

/**
 * The one place a phone decides how text it was handed was typed: one character with no composition open is a plain
 * typed key, so it goes as paired typing (a backtick, `*`, `~`, `[`, `]` pair; the engine types anything else as
 * typing). A longer commit is typed as given; compositions, paste and text-service replacements go their own ways.
 */
private fun typedAction(value: String): EditorInputAction =
    if (value.codePointCount(0, value.length) == 1) EditorInputAction.PAIRED_TYPING else EditorInputAction.TYPING

/** A keyboard correction addresses a range without changing its opening history selection. */
internal fun EditorEngine.imeReplace(start: Int, end: Int, value: String) = input {
    val s = session ?: return@input
    val change = s.replaceOsUtf16(rev, EditorUtf16Range(start.toULong(), end.toULong()), units(value), emptyList())
    if (change != null) accept(change)
    else select(end, end, fromView = false) // An unchanged replacement still ends at its addressed range.
}

internal fun EditorEngine.imeSetComposing(value: String) = input {
    val s = session ?: return@input
    val o = mirror.overlay
    if (o == null) {
        val start = mirror.selStart; val end = mirror.selEnd
        val marked = s.composeUtf16(rev, EditorUtf16Range(start.toULong(), end.toULong()), units(value))
        val opened = DisplayMirror.Overlay(start, mirror.text.substring(start, end), mirror.text.substring(start, end))
        mirror.overlay = opened
        setMarked(opened, value, marked.runs)
    } else {
        val marked = s.composeUtf16(rev, EditorUtf16Range(o.start.toULong(), (o.start + o.original.length).toULong()), units(value))
        setMarked(o, value, marked.runs)
    }
}

internal fun EditorEngine.imeSetComposingRegion(start: Int, end: Int) = input {
    val s = session ?: return@input
    if (mirror.overlay != null) commitComposition(null)
    val a = minOf(start, end).coerceIn(0, mirror.text.length)
    val b = maxOf(start, end).coerceIn(0, mirror.text.length)
    val existing = mirror.text.substring(a, b)
    s.composeUtf16(rev, EditorUtf16Range(a.toULong(), b.toULong()), units(existing))
    mirror.overlay = DisplayMirror.Overlay(a, existing, existing)
    postUpdate(edits = emptyList(), windows = emptyList())
}

internal fun EditorEngine.imeFinishComposing() = input {
    if (mirror.overlay != null) commitComposition(null)
}

internal fun EditorEngine.imeDeleteSurrounding(before: Int, after: Int) = input {
    // A keyboard's one-step delete over a range is its Backspace or Delete key on the selection (FUTO Keyboard sends it
    // so): it removes the selection, a selected block whole, not the character beside it (area 5 verifier, P107, P110).
    if (mirror.selStart != mirror.selEnd && mirror.overlay == null) {
        if (before == 1 && after == 0) return@input key(EditorParagraphKey.BACKSPACE)
        if (before == 0 && after == 1) return@input key(EditorParagraphKey.DELETE)
    }
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

internal fun EditorEngine.imeSetSelection(start: Int, end: Int) = input {
    select(start, end, fromView = false)
}

internal fun EditorEngine.key(key: EditorParagraphKey) = input {
    if (session == null) return@input
    if (mirror.overlay != null) commitComposition(null)
    if (editingCell && (key == EditorParagraphKey.TAB || key == EditorParagraphKey.SHIFT_TAB) &&
        tableTab(key == EditorParagraphKey.SHIFT_TAB)) return@input
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
        else postUpdate(edits, listOf(planStyleWindow(o.start, (o.start + o.original.length).coerceAtMost(tailStart()))))
    }
    streamTail(0)
}

internal fun EditorEngine.setMarked(o: DisplayMirror.Overlay, value: String, runs: List<EditorMarkedRun>) {
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
    else postUpdate(visible, emptyList(), marked = markedSpans(o.start, newShown, runs))
}

/** The engine's formats for the marked text, placed in the view and cut to what it shows. */
private fun markedSpans(start: Int, shown: Int, runs: List<EditorMarkedRun>): List<SpanSpec.Inline> = runs.mapNotNull { run ->
    val a = start + run.startUtf16.toInt()
    val b = minOf(start + run.endUtf16.toInt(), shown)
    if (a >= b) null else SpanSpec.Inline(
        a, b,
        bold = EditorInlineFormat.BOLD in run.formats,
        italic = EditorInlineFormat.ITALIC in run.formats,
        strike = EditorInlineFormat.STRIKE in run.formats,
        code = EditorInlineFormat.CODE in run.formats,
    )
}

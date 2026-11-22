package com.futo.notes.textfirst

import android.text.Selection

/**
 * The view's selection changed (a handle, a tap, the engine's update): repaint what it covers, fit it out of objects
 * and to what code blocks take, and report it to the engine unless the engine set it.
 */
internal fun TextFirstEditText.selectionChanged(selStart: Int, selEnd: Int) {
    if (coversImage(selStart, selEnd) || coversImage((renderedSelection shr 32).toInt(), renderedSelection.toInt())) invalidate()
    val shown = renderedSelection
    renderedSelection = (selStart.toLong() shl 32) or (selEnd.toLong() and 0xffffffffL)
    selectedObject = imageSelectedWhole(selStart, selEnd)
    // A loading note clamps the block to the text it has; the block stays selected.
    selectedCodeBlock = selectedCodeBlock?.takeIf { it.first == selStart && (it.second == selEnd || !contentComplete && selEnd <= it.second) }
    val painted = paintCodeSelection(selStart, selEnd, settled = settlingFromEngine)
    if (applying) return
    val e = editableText ?: return
    // The end sentinel is not a caret position (an empty Editable has none yet).
    val last = (e.length - 1).coerceAtLeast(0)
    // The view's own range is the one painted (a handle carried out of a code block takes it whole): Share and the
    // handle that was not dragged read it, as Copy reads the engine's (round 3, N1). It is fitted out of objects too.
    val (wantStart, wantEnd) = painted?.let { it.start to it.end } ?: (selStart to selEnd)
    val (a, b) = clampSelectionOutOfAtoms(e, wantStart.coerceAtMost(last), wantEnd.coerceAtMost(last), shown)
    if (a != selStart || b != selEnd) {
        val wasApplying = applying
        applying = true
        try { Selection.setSelection(e, a, b) } finally { applying = wasApplying }
    }
    engine?.viewSelection(appliedSeq, a, b, placed = !movingSelectionItself)
}

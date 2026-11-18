package com.futo.notes.textfirst

import android.text.Editable

/**
 * Atoms have caret stops only at their two ends. Images and a table's delimiter row are the engine's: place_selection
 * fits a placed selection out of them and the view shows its answer. Dividers, wikilinks (place_selection leaves them
 * as they are) and table rows (Android's grid, whose cells are edited in a field) stay clamped here.
 */
internal fun clampSelectionOutOfAtoms(e: Editable, start: Int, end: Int, shown: Long): Pair<Int, Int> {
    val shownStart = (shown shr 32).toInt()
    val shownEnd = shown.toInt()
    fun clamp(p: Int, other: Int, shownEdge: Int, shownOther: Int): Int {
        for (atom in e.getSpans(p, p, TfAtom::class.java)) {
            val s = e.getSpanStart(atom)
            val en = e.getSpanEnd(atom)
            if (p !in (s + 1) until en) continue
            // A handle dragged inside a picture the shown selection already takes whole sets that end inside it again
            // on every move: the engine's answer for that picture stands, and the move is not drawn without the tint.
            if (atom is TfImage) return if (other == shownOther && (shownEdge == s || shownEdge == en)) shownEdge else p
            if (atom is TfTableDelimiter) continue
            return if (p - s <= en - p) s else en
        }
        return p
    }
    return clamp(start, end, shownStart, shownEnd) to clamp(end, start, shownEnd, shownStart)
}

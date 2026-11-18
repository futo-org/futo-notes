package com.futo.notes.textfirst

import android.text.Editable

/**
 * Atoms have caret stops only at their two ends. Images and a table's delimiter row are the engine's: place_selection
 * fits a placed selection out of them and the view shows its answer. Dividers, wikilinks (place_selection leaves them
 * as they are) and table rows (Android's grid, whose cells are edited in a field) stay clamped here.
 */
internal fun clampSelectionOutOfAtoms(e: Editable, start: Int, end: Int): Pair<Int, Int> {
    fun clamp(p: Int): Int {
        for (atom in e.getSpans(p, p, TfAtom::class.java)) {
            if (atom is TfImage || atom is TfTableDelimiter) continue
            val s = e.getSpanStart(atom)
            val en = e.getSpanEnd(atom)
            if (p in (s + 1) until en) return if (p - s <= en - p) s else en
        }
        return p
    }
    return clamp(start) to clamp(end)
}

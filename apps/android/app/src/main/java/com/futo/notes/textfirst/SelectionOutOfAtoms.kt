package com.futo.notes.textfirst

import android.text.Editable

/**
 * Atoms have caret stops only at their two ends. Images are the engine's: a placed selection is fitted out of them by
 * place_selection and the view shows its answer. Dividers, wikilinks and table rows and delimiters, which the engine
 * does not fit, stay clamped here.
 */
internal fun clampSelectionOutOfAtoms(e: Editable, start: Int, end: Int): Pair<Int, Int> {
    fun clamp(p: Int): Int {
        for (atom in e.getSpans(p, p, TfAtom::class.java)) {
            if (atom is TfImage) continue
            val s = e.getSpanStart(atom)
            val en = e.getSpanEnd(atom)
            if (p in (s + 1) until en) return if (p - s <= en - p) s else en
        }
        return p
    }
    return clamp(start) to clamp(end)
}

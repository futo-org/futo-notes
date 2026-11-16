package com.futo.notes.textfirst

import android.text.Editable

/** Atoms have caret stops only at their two ends (images.md). */
internal fun clampSelectionOutOfAtoms(e: Editable, start: Int, end: Int): Pair<Int, Int> {
    fun clamp(p: Int): Int {
        for (atom in e.getSpans(p, p, TfAtom::class.java)) {
            val s = e.getSpanStart(atom)
            val en = e.getSpanEnd(atom)
            if (p in (s + 1) until en) return if (p - s <= en - p) s else en
        }
        return p
    }
    return clamp(start) to clamp(end)
}

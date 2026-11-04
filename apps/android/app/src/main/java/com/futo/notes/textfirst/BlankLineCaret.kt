package com.futo.notes.textfirst

import android.graphics.drawable.Drawable
import android.graphics.drawable.InsetDrawable

/**
 * The caret on a blank line between blocks. [TfBlankLine] draws that line at half height to stand
 * in for the block gap, and the TextView sizes the caret to its line, so the caret there was half
 * the height of the one on every line of text: it read as cut off, above a heading most of all
 * (the heading's own top margin sits right under it). Whatever line the TextView asks the caret
 * for, this one keeps the height of a line of text, centred on that line.
 */
internal class BlankLineCaret(base: Drawable, private val textHeight: () -> Int) : InsetDrawable(base, 0) {
    override fun setBounds(left: Int, top: Int, right: Int, bottom: Int) {
        val grow = (textHeight() - (bottom - top)).coerceAtLeast(0)
        super.setBounds(left, top - grow / 2, right, bottom + (grow - grow / 2))
    }
}

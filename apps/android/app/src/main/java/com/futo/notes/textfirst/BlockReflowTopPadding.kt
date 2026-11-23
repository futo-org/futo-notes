package com.futo.notes.textfirst

import android.os.Build
import android.text.StaticLayout

/** Android's top font padding belongs to the first visual row, regardless of which block draws there. */
internal class BlockReflowTopPadding(private val view: TextFirstEditText, private val wholeBlock: Boolean) {
    private var measured: Pair<BlockSlot, Float>? = null

    val current: Float get() = if (wholeBlock && view.includeFontPadding) -(view.layout?.topPadding ?: 0).toFloat() else 0f

    /** Work in the painted row coordinates, leaving the old first row's blank top padding behind. */
    fun boundaryY(slot: BlockSlot): Float? =
        view.boundaryY(slot)?.let { if (slot.offset == 0 && !slot.end) it + current else it }

    /** A leading decoration can paint into padding that remains on the same first row. */
    fun retainedAt(slot: BlockSlot, first: BlockSlot): Float =
        if (slot == first && slot.offset == 0 && !slot.end) current else 0f

    fun after(first: BlockSlot): Float {
        if (!wholeBlock || first.offset == 0 || !view.includeFontPadding) return current
        measured?.let { (slot, padding) -> if (slot == first) return padding }
        val layout = view.layout ?: return current
        val text = view.editableText ?: return current
        val end = text.indexOf('\n', first.offset).let { if (it < 0) text.length else it + 1 }
        val builder = StaticLayout.Builder.obtain(text, first.offset, end, view.paint, layout.width)
            .setIncludePad(true)
            .setUseLineSpacingFromFallbacks(view.isFallbackLineSpacing)
            .setBreakStrategy(view.breakStrategy)
            .setHyphenationFrequency(view.hyphenationFrequency)
        if (Build.VERSION.SDK_INT >= 29) builder.setTextDirection(view.textDirectionHeuristic)
        val padding = -builder.build().topPadding.toFloat()
        measured = first to padding
        return padding
    }

    fun invalidate() { measured = null }
}

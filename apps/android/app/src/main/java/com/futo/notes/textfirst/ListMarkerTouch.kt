package com.futo.notes.textfirst

import android.view.MotionEvent

/**
 * A hold on a list item's marker with the keyboard up selects the marker alone, as one character, with the handles and
 * the text menu (Mason). With the keyboard down a hold lifts the block (BlockLift). A tap is the platform's: it puts the
 * caret on the nearer side of the marker, as beside any character.
 */
internal class ListMarkerTouch(private val view: TextFirstEditText) {
    private var downX = 0f
    private var downY = 0f

    /** The last press selected a marker: its lift must not also tick a checkbox. */
    var held = false
        private set

    fun onTouch(event: MotionEvent) {
        if (event.actionMasked != MotionEvent.ACTION_DOWN) return
        downX = event.x
        downY = event.y
        held = false
    }

    /**
     * Select the marker under the press, a checkbox anywhere its tap would tick it; the platform then opens its menu.
     * Only with the note's own keyboard up: unfocused, a hold lifts its block (BlockLift), or another field keeps the
     * keyboard and the platform's long press runs as on any text.
     */
    fun longPress(): Boolean {
        if (!view.isFocused) return false
        val start = listMarkerAt(view, downX, downY).takeIf { it >= 0 } ?: checkboxAt(view, view.style, downX, downY)
        if (start < 0) return false
        // An open text menu would make the platform take a press inside the new selection as a drag of it.
        view.renderHold.closeTextMenus()
        view.setSelection(start, start + 1)
        held = true
        return true
    }
}

/** The offset of the list marker unit drawn under (x, y), view coordinates, or -1. */
internal fun listMarkerAt(view: TextFirstEditText, x: Float, y: Float): Int {
    val layout = view.layout ?: return -1
    val text = view.editableText ?: return -1
    val localX = x - view.totalPaddingLeft + view.scrollX
    val localY = y - view.totalPaddingTop + view.scrollY
    if (localY < 0 || localY >= layout.height) return -1
    val line = layout.getLineForVertical(localY.toInt())
    val start = layout.getLineStart(line)
    val marker = text.getSpans(start, minOf(start + 1, text.length), TfListMarker::class.java)
        .firstOrNull { text.getSpanStart(it) == start } ?: return -1
    // Its two caret stops are its two edges, the leading one on the right in a right-to-left item.
    val left = minOf(layout.getPrimaryHorizontal(start), layout.getPrimaryHorizontal(start + 1))
    return if (localX >= left && localX < left + marker.width) start else -1
}

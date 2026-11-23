package com.futo.notes.textfirst

import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlin.math.abs

/** What a tap on a grid reaches beyond the cell it lands in; the controller and the cell host set them. */
internal class TableTapHooks {
    /** A tap in a box the row lacks: the row's start offset, its column, the applied view sequence. */
    var missing: ((Int, Int, Int) -> Unit)? = null
    /** Whether a cell of the row's table is open: a link tap then opens the tapped cell instead. */
    var tableOpen: (TfTableRow) -> Boolean = { false }
}

/** A link in a table cell opens as a paragraph link does: an external one by the app's opener, a wikilink to its note. */
internal fun TextFirstEditText.openCellLink(run: CellRun): Boolean = when {
    run.link != null -> onOpenUrl?.invoke(run.link) ?: false
    run.wiki && run.noteId != null -> { onOpenWikilink?.invoke(WikilinkDestination.Note(run.noteId)); onOpenWikilink != null }
    else -> false
}

/** Native grid gestures: tap one cell, scroll columns together, or scroll through the note vertically. */
internal class TableGridTouch(
    private val view: TextFirstEditText,
    private val edit: (GridCell, Int) -> Unit,
    private val redraw: (TableScroll) -> Unit,
) {
    val hooks = TableTapHooks()
    private var down: TfTableRow? = null
    private var x = 0f
    private var y = 0f
    private var moved = false
    private var vertical = false
    /** This contact scrolls the grid (sideways or the note): it is no block lift. */
    val scrolling get() = down != null && moved

    fun onTouch(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                down = view.tableRowAt(event.y)
                if (down == null) return false
                x = event.x; y = event.y; moved = false; vertical = false
                view.parent?.requestDisallowInterceptTouchEvent(true)
                return true
            }
            MotionEvent.ACTION_UP -> {
                val row = down ?: return false
                if (!moved) view.tableTapAt(row, event.x, event.y)?.let { tap ->
                    val link = tap.link
                    if (link != null && !hooks.tableOpen(row) && view.openCellLink(link)) Unit
                    else if (tap.cell != null) edit(tap.cell, tap.caret)
                    else if (tap.column >= row.row.cells.size) view.editableText?.getSpanStart(row)?.takeIf { it >= 0 }?.let { hooks.missing?.invoke(it, tap.column, view.appliedSeq) }
                }
                down = null
                if (moved && vertical) view.scroll.release()
                view.parent?.requestDisallowInterceptTouchEvent(false)
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val row = down ?: return false
                val dx = x - event.x
                val dy = y - event.y
                val slop = ViewConfiguration.get(view.context).scaledTouchSlop
                if (abs(dx) > slop || abs(dy) > slop || moved) {
                    if (!moved) vertical = abs(dy) > abs(dx)
                    moved = true
                    if (vertical) {
                        view.scroll.dragBy(dy.toInt())
                        y = event.y
                    } else {
                        row.scrollBy(dx); x = event.x
                        redraw(row.scroll)
                    }
                }
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                if (down == null) return false
                down = null
                view.parent?.requestDisallowInterceptTouchEvent(false)
                return true
            }
        }
        return false
    }

}

/** TextView caches drawing separately: changing span data also invalidates its text display list. */
internal fun TextFirstEditText.invalidateTableScroll(scroll: TableScroll) {
    redrawTableRows { it.scroll === scroll }
    invalidate()
}

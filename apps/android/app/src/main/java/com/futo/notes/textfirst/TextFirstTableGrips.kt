package com.futo.notes.textfirst

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.text.SpannableString
import android.text.style.ForegroundColorSpan
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.PopupMenu
import uniffi.futo_notes_ffi.EditorTableCommand

// Table grips: while a cell is open, a row grip at its row's left edge and a column grip on the table's top edge
// above its column. Each opens a native popup menu anchored at it; the keyboard and the cell stay up. The six
// row/column items are the engine's `table_command`s (shown disabled where it forbids them); Delete table is the
// engine's own whole-table deletion. The strings are hard-coded English (listed in the ledger for localisation).

/** What a grip does to the note; the controller owns the engine. */
internal interface TableGripActions {
    fun command(which: EditorTableCommand)
    fun deleteTable()
    /** A grip menu opened (true) or closed (false): the keyboard toolbar ignores taps while it shows. */
    fun menuShowing(showing: Boolean)
}

/** One grip: a hit area with a smaller six-dot pill drawn at [pillCenter] (the hit area reaches outward from the pill). */
internal class TableGripView(context: Context, private val look: TextFirstStyle, private val across: Int, val row: Boolean) : View(context) {
    var pillWidth = 0f
    var pillHeight = 0f
    var pillCenterX = 0f
    var pillCenterY = 0f
    var onTap: (TableGripView) -> Unit = {}
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt() }
    private val pill = RectF()

    init {
        // A grip never takes focus: the cell's field keeps it, and with it the keyboard.
        isFocusable = false
        isFocusableInTouchMode = false
        isClickable = true
        importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO
        setOnClickListener { onTap(this) }
    }

    override fun onDraw(canvas: Canvas) {
        fill.color = look.linkColor
        if (isPressed) fill.alpha = 128
        pill.set(pillCenterX - pillWidth / 2, pillCenterY - pillHeight / 2, pillCenterX + pillWidth / 2, pillCenterY + pillHeight / 2)
        canvas.drawRoundRect(pill, look.dp(6f), look.dp(6f), fill)
        val down = 6 / across
        val gap = look.dp(5f)
        val r = look.dp(1.6f)
        val w = (across - 1) * gap
        val h = (down - 1) * gap
        for (i in 0 until across) for (j in 0 until down) {
            canvas.drawCircle(pillCenterX - w / 2 + i * gap, pillCenterY - h / 2 + j * gap, r, dot)
        }
    }

    override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }
}

internal class TableGrips(
    private val host: ViewGroup,
    private val look: TextFirstStyle,
    private val actions: TableGripActions,
) {
    private val rowGrip = TableGripView(host.context, look, across = 2, row = true).apply {
        pillWidth = look.dp(14f); pillHeight = look.dp(26f); contentDescription = "Row actions"
    }
    private val columnGrip = TableGripView(host.context, look, across = 3, row = false).apply {
        pillWidth = look.dp(26f); pillHeight = look.dp(14f); contentDescription = "Column actions"
    }
    private val all = listOf(rowGrip, columnGrip)
    private var attached = false
    private var controls: uniffi.futo_notes_ffi.EditorTableControls? = null
    var menuShowing = false; private set
    private var menu: PopupMenu? = null

    init { all.forEach { it.onTap = ::open } }

    private fun attach() {
        if (attached) return
        all.forEach { host.addView(it, ViewGroup.LayoutParams(0, 0)) }
        attached = true
    }

    /** Nothing is left on screen: the cell closed, or the note was left. */
    fun remove() {
        menu?.dismiss()
        menu = null
        setMenuShowing(false)
        if (attached) all.forEach { host.removeView(it) }
        attached = false
    }

    fun hide() { all.forEach { it.visibility = View.GONE } }

    /** A tap at ([x], [y]) in the host landed on a showing grip: it is the grip's, not a tap outside the cell. */
    fun hits(x: Int, y: Int): Boolean = attached && all.any { it.visibility == View.VISIBLE && x in it.left until it.right && y in it.top until it.bottom }

    private fun place(view: TableGripView, left: Float, top: Float, width: Float, height: Float) {
        val l = left.toInt(); val t = top.toInt(); val w = width.toInt().coerceAtLeast(1); val h = height.toInt().coerceAtLeast(1)
        if (view.layoutParams.width != w || view.layoutParams.height != h) {
            view.layoutParams.width = w; view.layoutParams.height = h
            view.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
        }
        if (view.left != l || view.top != t || view.right != l + w || view.bottom != t + h) view.layout(l, t, l + w, t + h)
    }

    /**
     * Put both grips by the open cell. [cell] is its box in the host's coordinates, [geometry] the table's visible
     * extent and header line (note coordinates, which the note view shares with the host: it fills it).
     *
     * Hit areas must not take taps meant for text: the row grip is the margin plus [ROW_REACH] into the cell, as
     * tall as the open row; the column grip is [COLUMN_HIT] wide and only [REACH] taller than its pill.
     */
    fun layout(cell: RectF, geometry: TableCellGeometry, update: CellUpdate, noteTop: Float, viewHeight: Float) {
        controls = update.controls
        attach()
        val tableLeft = geometry.visibleLeft
        val tableRight = geometry.visibleRight
        val colMin = maxOf(cell.left, tableLeft)
        val colMax = minOf(cell.right, tableRight)
        // The pair belongs to the open cell: both go while less than 20 dp of it is in view.
        val visible = colMax - colMin >= look.dp(20f)
        all.forEach { it.visibility = if (visible) View.VISIBLE else View.GONE }
        if (!visible) return

        val rowH = maxOf(look.dp(44f), cell.height())
        rowGrip.pillCenterX = tableLeft
        rowGrip.pillCenterY = rowH / 2
        place(rowGrip, 0f, cell.centerY() - rowH / 2, tableLeft + look.dp(ROW_REACH), rowH)
        rowGrip.invalidate()

        // The pill sits on the table's top edge. It is pushed down until it fits whole inside the view: for a table
        // that starts the note, and, once the header has scrolled off the top, it sticks to the top of the visible
        // table over the open column. A stuck grip must not cover the open cell's own text.
        val pillHalf = columnGrip.pillHeight / 2
        val reach = look.dp(REACH)
        val header = noteTop + geometry.headerTop
        val pillY = maxOf(header, noteTop + pillHalf + 1)
        val colY = maxOf(noteTop, pillY - pillHalf - reach)
        val colH = pillY + pillHalf + reach - colY
        if (pillY > header && (cell.top + look.dp(10f) < colY + colH || cell.bottom < noteTop || cell.top > viewHeight)) {
            columnGrip.visibility = View.GONE
        }
        val hit = look.dp(COLUMN_HIT)
        columnGrip.pillCenterX = hit / 2
        columnGrip.pillCenterY = pillY - colY
        place(columnGrip, (colMin + colMax) / 2 - hit / 2, colY, hit, colH)
        columnGrip.invalidate()
        all.forEach { it.bringToFront() }
    }

    private fun setMenuShowing(showing: Boolean) {
        if (menuShowing == showing) return
        menuShowing = showing
        actions.menuShowing(showing)
    }

    /** The grip's menu, built as it opens from the engine's controls: three commands, a divider, Delete table. */
    private fun open(grip: TableGripView) {
        if (menu != null) return
        val can = controls
        val popup = PopupMenu(grip.context, grip)
        popup.menu.setGroupDividerEnabled(true)
        fun add(group: Int, order: Int, title: String, enabled: Boolean, destructive: Boolean = false, run: () -> Unit) {
            val text = SpannableString(title)
            if (destructive) text.setSpan(ForegroundColorSpan(look.dangerColor), 0, text.length, 0)
            val item: MenuItem = popup.menu.add(group, order, order, text)
            item.isEnabled = enabled
            item.setOnMenuItemClickListener { run(); true }
        }
        if (grip.row) {
            add(1, 0, "Add above", can?.insertRowAbove == true) { actions.command(EditorTableCommand.INSERT_ROW_ABOVE) }
            add(1, 1, "Add below", can?.insertRowBelow == true) { actions.command(EditorTableCommand.INSERT_ROW_BELOW) }
            add(1, 2, "Delete row", can?.deleteRow == true, destructive = true) { actions.command(EditorTableCommand.DELETE_ROW) }
        } else {
            add(1, 0, "Add to left", can?.insertColumnLeft == true) { actions.command(EditorTableCommand.INSERT_COLUMN_LEFT) }
            add(1, 1, "Add to right", can?.insertColumnRight == true) { actions.command(EditorTableCommand.INSERT_COLUMN_RIGHT) }
            add(1, 2, "Delete column", can?.deleteColumn == true, destructive = true) { actions.command(EditorTableCommand.DELETE_COLUMN) }
        }
        add(2, 3, "Delete table", can != null, destructive = true) { actions.deleteTable() }
        popup.setOnDismissListener { menu = null; setMenuShowing(false) }
        menu = popup
        setMenuShowing(true)
        popup.show()
    }

    companion object {
        /** How far the row grip's area reaches into the first column (the pill's right edge is 7 dp in). */
        const val ROW_REACH = 8f
        /** How far a column grip's area reaches past its pill. */
        const val REACH = 4f
        const val COLUMN_HIT = 80f
    }
}

package com.futo.notes.textfirst

import android.graphics.Rect
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ViewTreeObserver
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import kotlin.math.roundToInt

/** One stable native parent: Android routes grid/note gestures and field gestures to their real children. */
internal class TextFirstTableCellHost(
    private val note: TextFirstEditText,
    private val finishCell: () -> Unit,
    actions: TableGripActions,
) : FrameLayout(note.context) {
    private val grips = TableGrips(this, note.style, actions)
    private data class Anchor(val row: Int, val column: Int, val width: Int, val height: Int)
    private var cell: TableCellEditText? = null
    private var anchor: Anchor? = null
    private var styled: TableCellGeometry? = null
    private var bounds: Rect? = null
    private var started = false
    /**
     * The cell opened while another field of the screen had the keyboard (the find bar stepping onto its match): it
     * stays unshown, the note drawing it and its match, takes no focus, and leaving it hides nothing, until a press on
     * the table asks for a cell (Mason, S23).
     */
    private var yielded = false
    /** When a press last landed on the table: the cell it opens, within [ASKED_MS], is the one asked for. */
    private var pressedTableAt = 0L
    private val asked get() = android.os.SystemClock.uptimeMillis() - pressedTableAt < ASKED_MS
    private var placing = false
    private var observingNote = false
    private var observer: ViewTreeObserver? = null
    private val settle: () -> Unit = { placeCell() }
    private val frames = ViewTreeObserver.OnPreDrawListener { placeCell(); true }
    var onBoundsChanged: (Rect?) -> Unit = {}
        set(value) { field = value; value(bounds?.let(::Rect)) }
    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true
        private fun outside(e: MotionEvent): Boolean = cell != null && !note.scroll.stoppingTouch &&
            note.tableRowAt(e.y - note.top)?.let { note.tableCellAt(it, e.x - note.left) } == null
        override fun onSingleTapUp(e: MotionEvent): Boolean {
            if (outside(e)) finishCell()
            return false
        }
        override fun onLongPress(e: MotionEvent) { if (outside(e)) finishCell() }
    })

    /** Whether a cell of [row]'s table is the open one. */
    private fun opensTable(row: TfTableRow): Boolean {
        val update = cell?.update ?: return false
        val e = note.editableText ?: return false
        if (update.rowStart !in 0 until e.length) return false
        return e.getSpans(update.rowStart, update.rowStart, TfTableRow::class.java).any { e.getSpanStart(it) == update.rowStart && it.scroll === row.scroll }
    }

    init {
        note.tableTouch.hooks.tableOpen = ::opensTable
        clipChildren = true
        clipToPadding = true
        addView(note, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    fun setCell(next: TableCellEditText?) {
        if (cell === next) return
        cell?.let { previous ->
            // Snapshot focus/token before native removal clears them. An outside
            // note tap has already transferred focus and must retain its keyboard.
            val ownedKeyboard = previous.isFocused
            val token = previous.windowToken
            if (ownedKeyboard && token != null) context.getSystemService(InputMethodManager::class.java)
                .hideSoftInputFromWindow(token, 0)
            removeView(previous)
        }
        if (next == null) grips.remove()
        cell = next
        yielded = false
        anchor = null
        styled = null
        started = false
        reportBounds(null)
        next?.let { it.alpha = 0f; it.openLink = { run -> note.openCellLink(run) }; addView(it, LayoutParams(0, 0)) }
        requestLayout()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        observer = viewTreeObserver.also { it.addOnPreDrawListener(frames) }
        note.onViewportReady = settle
    }

    override fun onDetachedFromWindow() {
        endFields()
        stopObserving()
        super.onDetachedFromWindow()
    }

    /**
     * Leaving the note, or the editor losing its window: no field keeps focus or the keyboard it raised. A code
     * block's header field has lost focus to the screen's back arrow by now, but stays open with its keyboard up,
     * which then stood over the notes list.
     */
    private fun endFields() {
        val headerField = note.codeTouch.headerField
        if (findFocus() == null && headerField.openField == null) return
        context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(windowToken, 0)
        headerField.close()
        findFocus()?.clearFocus()
    }

    private fun stopObserving() {
        observer?.takeIf { it.isAlive }?.removeOnPreDrawListener(frames)
        observer = null
        if (note.onViewportReady === settle) note.onViewportReady = null
        val cancel = MotionEvent.obtain(0L, 0L, MotionEvent.ACTION_CANCEL, 0f, 0f, 0)
        gestures.onTouchEvent(cancel)
        cancel.recycle()
        observingNote = false
    }

    fun release() {
        stopObserving()
        setCell(null)
        grips.remove()
        removeView(note)
        onBoundsChanged = {}
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        note.layout(0, 0, right - left, bottom - top)
        placeCell()
    }

    /** Also runs after TextView's own pre-draw layout/reveal, before the window is painted. */
    private fun placeCell() {
        if (placing) return
        val field = cell ?: return
        placing = true
        try {
            val target = field.placementTarget(note)
            val nextAnchor = target?.let { Anchor(it.rowStart, it.column, note.width, note.height) }
            val revealColumn = nextAnchor != null && (anchor?.row != nextAnchor.row ||
                anchor?.column != nextAnchor.column || anchor?.width != nextAnchor.width)
            val geometry = target?.let {
                note.tableCellGeometry(it, revealRow = anchor != nextAnchor, revealColumn = revealColumn)
            }
            if (geometry == null) {
                field.alpha = 0f // Keep its attachment, focus and input connection while the note frame arrives.
                grips.hide()
                reportBounds(null)
                return
            }
            anchor = nextAnchor
            if (styled != geometry || field.styleStale) { field.applyGeometry(geometry); styled = geometry }
            val rect = geometry.bounds
            val x = note.left + rect.left.roundToInt()
            val y = note.top + rect.top.roundToInt()
            val w = rect.width().roundToInt().coerceAtLeast(1)
            val h = rect.height().roundToInt().coerceAtLeast(1)
            val needsLayout = field.isLayoutRequested
            if (field.measuredWidth != w || field.measuredHeight != h || needsLayout) {
                field.layoutParams.width = w
                field.layoutParams.height = h
                field.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
            }
            if (field.left != x || field.top != y || field.right != x + w || field.bottom != y + h || needsLayout) {
                field.layout(x, y, x + w, y + h)
            }
            // Clipped at the table's visible edges when the table is scrolled sideways.
            val clipLeft = (geometry.visibleLeft - rect.left).roundToInt().coerceIn(0, w)
            val clipRight = (geometry.visibleRight - rect.left).roundToInt().coerceIn(0, w)
            val clip = if (clipLeft > 0 || clipRight < w) Rect(clipLeft, 0, maxOf(clipLeft, clipRight), h) else null
            if (field.clipBounds != clip) field.clipBounds = clip
            if (!asked && (yielded || !field.isFocused && rootView.findFocus()?.let { it.onCheckIsTextEditor() && it !== note && it.parent !== this } == true)) {
                yielded = true
                field.alpha = 0f
                reportBounds(null)
                return
            }
            field.alpha = 1f
            reportBounds(Rect(field.left, field.top, field.right, field.bottom))
            grips.layout(android.graphics.RectF(field.left.toFloat(), field.top.toFloat(), field.right.toFloat(), field.bottom.toFloat()),
                geometry, checkNotNull(target), note.top.toFloat(), height.toFloat())
            if (!started) {
                started = true
                pressedTableAt = 0L
                field.requestFocus()
                field.post {
                    if (cell === field && field.isAttachedToWindow && field.isFocused) context.getSystemService(InputMethodManager::class.java)
                        .showSoftInput(field, InputMethodManager.SHOW_IMPLICIT)
                }
            }
        } finally { placing = false }
    }

    private fun reportBounds(next: Rect?) {
        if (bounds == next) return
        bounds = next
        onBoundsChanged(next?.let(::Rect))
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            pressedTableAt = if (note.tableRowAt(event.y - note.top) != null) event.downTime else 0L
            if (asked && yielded) { yielded = false; started = false; post { placeCell() } }
        }
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            val hit = Rect()
            cell?.getHitRect(hit)
            observingNote = cell != null && !hit.contains(event.x.toInt(), event.y.toInt()) && !grips.hits(event.x.toInt(), event.y.toInt())
        }
        val handled = super.dispatchTouchEvent(event)
        // Observe only gestures Android routed outside the active field. Native
        // ViewGroup hit-testing and the existing note gesture owners do the routing.
        if (observingNote) gestures.onTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) observingNote = false
        return handled
    }

    private companion object {
        const val ASKED_MS = 1_000L
    }
}

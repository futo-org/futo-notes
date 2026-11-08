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
) : FrameLayout(note.context) {
    private data class Anchor(val row: Int, val column: Int, val width: Int, val height: Int)
    private var cell: TableCellEditText? = null
    private var anchor: Anchor? = null
    private var styled: TableCellGeometry? = null
    private var bounds: Rect? = null
    private var started = false
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

    init {
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
        cell = next
        anchor = null
        styled = null
        started = false
        reportBounds(null)
        next?.let { it.alpha = 0f; addView(it, LayoutParams(0, 0)) }
        requestLayout()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        observer = viewTreeObserver.also { it.addOnPreDrawListener(frames) }
        note.onViewportReady = settle
    }

    override fun onDetachedFromWindow() {
        stopObserving()
        super.onDetachedFromWindow()
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
                reportBounds(null)
                return
            }
            anchor = nextAnchor
            if (styled != geometry) { field.applyGeometry(geometry); styled = geometry }
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
            field.alpha = 1f
            reportBounds(Rect(field.left, field.top, field.right, field.bottom))
            if (!started) {
                started = true
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
            val hit = Rect()
            cell?.getHitRect(hit)
            observingNote = cell != null && !hit.contains(event.x.toInt(), event.y.toInt())
        }
        val handled = super.dispatchTouchEvent(event)
        // Observe only gestures Android routed outside the active field. Native
        // ViewGroup hit-testing and the existing note gesture owners do the routing.
        if (observingNote) gestures.onTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) observingNote = false
        return handled
    }
}

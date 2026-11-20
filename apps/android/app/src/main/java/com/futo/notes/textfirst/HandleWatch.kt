package com.futo.notes.textfirst

import android.os.Build
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inspector.WindowInspector

/**
 * The platform's selection handles, so a handle carried to the note's edge drives CaretEdgeScroll. They draw in
 * windows of their own, which the note never sees a touch of; they are found by public structure only (API 29+):
 * a sub-panel window opened on the note's own window (its token) whose content is a single plain view (no ViewGroup: not a text
 * menu), found while the note has focus, so they are the note's. Each gets a listener that watches; only a move
 * inside an edge zone is kept from the handle, which then follows the selection the scroll places. The listener is
 * off while its window is gone and on again when the platform shows it; all of it goes when the note detaches.
 * Found nothing (another Editor, an OEM's), nothing is attached and the platform's behaviour is all there is.
 */
internal class HandleWatch(private val view: TextFirstEditText, private val edge: CaretEdgeScroll) {
    /** Each handle's window root, kept until the note detaches: the platform hides and shows the same window again. */
    private val handles = HashMap<View, View>()
    /** The end each handle being held moves, from where it was taken (two fingers may hold both). */
    private val holding = HashMap<View, CaretEdgeScroll.End>()

    private val listener = View.OnTouchListener { handle, event ->
        val at = IntArray(2).also(view::getLocationOnScreen)
        val x = event.rawX - at[0]
        val y = event.rawY - at[1]
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> edge.nearerEnd(x, y).let { holding[handle] = it; edge.grab(it, x, y, belowCaret = true) }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (holding.remove(handle) == edge.grabbed) edge.release()
        }
        val end = holding[handle]
        if (event.actionMasked != MotionEvent.ACTION_MOVE || end == null) return@OnTouchListener false
        if (edge.grabbed != end) edge.grab(end, x, y, belowCaret = true)
        // In an edge zone the scroll places the end: the handle's own step back to the row it stands on would undo it.
        edge.follow(x, y)
    }

    private val shown = object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(root: View) { handles[root]?.setOnTouchListener(listener) }
        override fun onViewDetachedFromWindow(root: View) {
            // A held handle the platform hides (its end out of view) still gets its finger's moves and UP.
            handles[root]?.let { if (it !in holding) it.setOnTouchListener(null) }
        }
    }

    private var searchUntil = 0L
    private val search = Runnable { if (look() == 0 && SystemClock.uptimeMillis() < searchUntil) searchNextFrame() }

    /**
     * A lift may show a handle, at once or once no second tap can follow (a tap on the caret, a swipe that brings a
     * selection back, each in a window the platform makes then): look on each frame for [SEARCH_MS], stopping at the
     * first one found.
     */
    fun searchAfterLift() {
        if (Build.VERSION.SDK_INT < 29) return
        searchUntil = SystemClock.uptimeMillis() + SEARCH_MS
        view.removeCallbacks(search)
        searchNextFrame()
    }

    private fun searchNextFrame(): Unit = view.postOnAnimation(search)

    /** Handles may have appeared (a tap placed the caret, a selection was made): watch any not watched yet; how many. */
    fun look(): Int {
        if (Build.VERSION.SDK_INT < 29 || !view.isFocused || !view.isAttachedToWindow) return 0
        val token = view.windowToken ?: return 0
        var found = 0
        for (root in WindowInspector.getGlobalWindowViews()) {
            if (root === view.rootView || root in handles) continue
            val params = root.layoutParams as? WindowManager.LayoutParams ?: continue
            if (params.type != WindowManager.LayoutParams.TYPE_APPLICATION_SUB_PANEL || params.token !== token) continue
            val handle = singleLeafOf(root) ?: continue
            handle.setOnTouchListener(listener)
            root.addOnAttachStateChangeListener(shown)
            handles[root] = handle
            found++
        }
        return found
    }

    /** The note left its window: nothing stays attached to the handles or their windows. */
    fun detach() {
        view.removeCallbacks(search)
        for ((root, handle) in handles) {
            root.removeOnAttachStateChangeListener(shown)
            handle.setOnTouchListener(null)
        }
        handles.clear()
        holding.clear()
        edge.release()
    }

    /** The window's only content when it is one plain view under at most a frame of one child each. */
    private fun singleLeafOf(root: View): View? {
        var at = root
        while (at is ViewGroup) {
            if (at.childCount != 1) return null
            at = at.getChildAt(0)
        }
        return at.takeIf { it !== root }
    }

    private companion object {
        const val SEARCH_MS = 1_000L
    }
}

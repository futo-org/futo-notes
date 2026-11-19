package com.futo.notes.textfirst

import android.os.Build
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
 * inside an edge zone is kept from the handle, which then follows the selection the scroll places. It is dropped
 * when that window goes or the note detaches.
 * Found nothing (another Editor, an OEM's), nothing is attached and the platform's behaviour is all there is.
 */
internal class HandleWatch(private val view: TextFirstEditText, private val edge: CaretEdgeScroll) {
    private val watched = ArrayList<View>()
    /** The end the handle being held moves, from where it was taken; null with no handle held. */
    private var holding: CaretEdgeScroll.End? = null

    private val listener = View.OnTouchListener { _, event ->
        val at = IntArray(2).also(view::getLocationOnScreen)
        val x = event.rawX - at[0]
        val y = event.rawY - at[1]
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> holding = edge.nearerEnd(x, y)
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { holding = null; edge.release(); view.removeCallbacks(lost) }
        }
        // In an edge zone the scroll places the end: the handle's own step back to the row it stands on would undo it.
        event.actionMasked == MotionEvent.ACTION_MOVE && holding?.let { edge.follow(it, x, y) } == true
    }

    /** A held handle whose window went (the platform hides it while its end is out of place) and has not come back. */
    private val lost = Runnable { forgetAll() }

    private val gone = object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(v: View) { view.removeCallbacks(lost) }
        override fun onViewDetachedFromWindow(v: View) {
            // Held, it comes back with the same finger (its UP still arrives); the scroll goes on meanwhile.
            if (holding != null && watched.any { it.rootView === v }) { view.postDelayed(lost, LOST_MS); return }
            v.removeOnAttachStateChangeListener(this)
            forget(v)
        }
    }

    /** Handles may have appeared (a tap placed the caret, a selection was made): watch any not watched yet. */
    fun look() {
        if (Build.VERSION.SDK_INT < 29 || !view.isFocused || !view.isAttachedToWindow) return
        val token = view.windowToken ?: return
        for (root in WindowInspector.getGlobalWindowViews()) {
            if (root === view.rootView) continue
            val params = root.layoutParams as? WindowManager.LayoutParams ?: continue
            if (params.type != WindowManager.LayoutParams.TYPE_APPLICATION_SUB_PANEL || params.token !== token) continue
            val handle = singleLeafOf(root) ?: continue
            if (handle in watched) continue
            handle.setOnTouchListener(listener)
            root.addOnAttachStateChangeListener(gone)
            watched += handle
        }
    }

    /** The note left its window: nothing stays attached to the handles. */
    fun detach() = forgetAll()

    private fun forgetAll() {
        view.removeCallbacks(lost)
        for (handle in watched.toList()) {
            handle.rootView.removeOnAttachStateChangeListener(gone)
            forget(handle)
        }
        holding = null
        edge.release()
    }

    private fun forget(root: View) {
        val handle = if (root in watched) root else watched.firstOrNull { it.rootView === root } ?: return
        handle.setOnTouchListener(null)
        watched -= handle
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
        const val LOST_MS = 1_500L
    }
}

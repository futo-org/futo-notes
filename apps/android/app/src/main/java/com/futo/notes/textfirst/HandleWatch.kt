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
 * inside an edge zone is kept from the handle, which then follows the selection the scroll places. The listener is
 * off while its window is gone and on again when the platform shows it; all of it goes when the note detaches.
 * Found nothing (another Editor, an OEM's), nothing is attached and the platform's behaviour is all there is.
 */
internal class HandleWatch(private val view: TextFirstEditText, private val edge: CaretEdgeScroll) {
    /** Each handle's window root, kept until the note detaches: the platform hides and shows the same window again. */
    private val handles = HashMap<View, View>()
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

    /** A held handle whose window went and has not come back within [LOST_MS]: the finger is no longer reported. */
    private val lost = Runnable { holding = null; edge.release() }

    private val shown = object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(root: View) {
            view.removeCallbacks(lost)
            handles[root]?.setOnTouchListener(listener)
        }
        override fun onViewDetachedFromWindow(root: View) {
            // Held, it comes back with the same finger (its UP still arrives); the scroll goes on meanwhile.
            if (holding != null) { view.postDelayed(lost, LOST_MS); return }
            handles[root]?.setOnTouchListener(null)
        }
    }

    /** Handles may have appeared (a tap placed the caret, a selection was made): watch any not watched yet. */
    fun look() {
        if (Build.VERSION.SDK_INT < 29 || !view.isFocused || !view.isAttachedToWindow) return
        val token = view.windowToken ?: return
        for (root in WindowInspector.getGlobalWindowViews()) {
            if (root === view.rootView || root in handles) continue
            val params = root.layoutParams as? WindowManager.LayoutParams ?: continue
            if (params.type != WindowManager.LayoutParams.TYPE_APPLICATION_SUB_PANEL || params.token !== token) continue
            val handle = singleLeafOf(root) ?: continue
            handle.setOnTouchListener(listener)
            root.addOnAttachStateChangeListener(shown)
            handles[root] = handle
        }
    }

    /** The note left its window: nothing stays attached to the handles or their windows. */
    fun detach() {
        view.removeCallbacks(lost)
        for ((root, handle) in handles) {
            root.removeOnAttachStateChangeListener(shown)
            handle.setOnTouchListener(null)
        }
        handles.clear()
        holding = null
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
        const val LOST_MS = 1_500L
    }
}

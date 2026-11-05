package com.futo.notes.textfirst

import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent

/**
 * When the note view's background rendering (stream and style slices) waits.
 *
 * Android closes the floating text menu (Cut, Copy, Select all) and hides the
 * selection handles on every text change, so a slice landing under a finger
 * or an open menu took them away on its own. Held from the finger going down,
 * so a slice already on its way lands before a long press can open the menu;
 * through a long press whose menu has not opened yet (it opens after the text
 * classifier answers, off the main thread and often after the finger lifts);
 * and while a text menu is open. Released when none remains. UI thread.
 */
internal class RenderHold(private val view: TextFirstEditText) {
    var held = false
        private set
    private var touching = false
    private var menus = 0
    private var menuPending = false
    private val menuGaveUp = Runnable { menuPending = false; update() }

    fun touchStarting(event: MotionEvent) {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) { touching = true; update() }
    }

    fun touchEnded(event: MotionEvent) {
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            touching = false
            update()
        }
    }

    fun longPressed() {
        menuPending = true
        view.removeCallbacks(menuGaveUp)
        view.postDelayed(menuGaveUp, MENU_PENDING_MS)
        update()
    }

    private fun update() {
        val now = touching || menuPending || menus > 0
        if (now == held) return
        held = now
        view.engine?.holdRender(now)
    }

    /** Set as the view's selection and insertion action-mode callbacks; it only watches. */
    inner class MenuWatch : ActionMode.Callback {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
            menus++
            menuPending = false
            view.removeCallbacks(menuGaveUp)
            update()
            return true
        }
        override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = false
        override fun onActionItemClicked(mode: ActionMode, item: MenuItem) = false
        override fun onDestroyActionMode(mode: ActionMode) {
            menus = (menus - 1).coerceAtLeast(0)
            update()
        }
    }

    companion object {
        /** How long a long press holds background slices for a text menu that has not opened yet. */
        const val MENU_PENDING_MS = 1_500L
    }
}

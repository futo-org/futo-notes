package com.futo.notes.textfirst

import android.content.ClipboardManager
import android.graphics.Rect
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View

/**
 * Cut, Copy and Paste over a block a hold selected as one object. The TextView starts its menu only
 * for a selection its own gestures make; the engine selects the block, so the hold asks for this one.
 */
internal class CodeBlockCallout(private val note: TextFirstEditText) : ActionMode.Callback2() {
    private var mode: ActionMode? = null
    private var wanted = false
    val isShowing: Boolean get() = mode != null

    /** The block whose code starts at [codeStart] shows the callout once the engine selects it, at once if it already is. */
    fun showWhenSelected(codeStart: Int) {
        wanted = true
        note.selectedCodeBlock?.takeIf { codeStart in it.first..it.second }?.let(::onSelectedBlockChanged)
    }

    fun onSelectedBlockChanged(block: Pair<Int, Int>?) {
        if (block == null) {
            wanted = false
            mode?.finish()
            return
        }
        if (!wanted) return
        wanted = false
        mode?.finish()
        mode = note.startActionMode(this, ActionMode.TYPE_FLOATING)
    }

    fun onNoteScrolled() { mode?.invalidateContentRect() }

    override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
        menu.add(Menu.NONE, android.R.id.cut, 0, android.R.string.cut).setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
        menu.add(Menu.NONE, android.R.id.copy, 1, android.R.string.copy).setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
        if (note.context.getSystemService(ClipboardManager::class.java)?.hasPrimaryClip() == true) {
            menu.add(Menu.NONE, android.R.id.paste, 2, android.R.string.paste).setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
        }
        return true
    }

    override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean = false

    override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
        mode.finish()
        return note.onTextContextMenuItem(item.itemId)
    }

    override fun onDestroyActionMode(mode: ActionMode) {
        if (this.mode === mode) this.mode = null
    }

    /** The block's code lines, unclipped: the platform's toolbar clips them to the screen and hides while none shows. */
    override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
        val lines = note.selectedCodeBlock?.let(note::codeBlockLines) ?: return super.onGetContentRect(mode, view, outRect)
        val onScreen = note.totalPaddingTop - note.scrollY
        outRect.set(note.totalPaddingLeft, lines.first + onScreen, note.width - note.totalPaddingRight, lines.second + onScreen)
    }
}

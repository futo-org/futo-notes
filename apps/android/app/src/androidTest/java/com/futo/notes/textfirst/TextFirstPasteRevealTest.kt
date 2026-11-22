package com.futo.notes.textfirst

import android.content.ClipData
import android.content.ClipboardManager
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tester (round 2, F1): Paste from the menu over a held word left the page at the paste's start, the caret 200 lines
 * down off screen. The paste's edit closes the menu while the old range is still there; that close must not count the
 * caret as revealed.
 */
class TextFirstPasteRevealTest {
    private fun touch(view: TextFirstEditText, down: Long, time: Long, action: Int, x: Float, y: Float) {
        val event = MotionEvent.obtain(down, time, action, x, y, 0)
        event.source = InputDevice.SOURCE_TOUCHSCREEN
        try { view.dispatchTouchEvent(event) } finally { event.recycle() }
    }

    private val note = "Spacer paragraph.\n\n" + (1..20).joinToString("\n\n") { "line $it after" }
    private val clip = (1..200).joinToString("\n") { "pasted line $it" }

    /** The text menus open now (set by [holdWithMenu]). */
    private var openMenus: () -> Int = { 0 }

    private suspend fun assertMenuOpen(what: String) = assertTrue("the word's menu is open at $what", withContext(Dispatchers.Main) { openMenus() } > 0)

    /** Hold [word] with the note focused until its text menu is open; fails if the menu never opens. */
    private suspend fun holdWithMenu(c: TextFirstController, word: String) {
        val view = c.view
        var menus = 0
        openMenus = { menus }
        val (x, y) = withContext(Dispatchers.Main) {
            view.isFocusableInTouchMode = true
            view.requestFocus()
            val inner = view.customSelectionActionModeCallback
            view.customSelectionActionModeCallback = object : android.view.ActionMode.Callback {
                override fun onCreateActionMode(mode: android.view.ActionMode, menu: android.view.Menu): Boolean { menus++; return inner?.onCreateActionMode(mode, menu) ?: true }
                override fun onPrepareActionMode(mode: android.view.ActionMode, menu: android.view.Menu) = inner?.onPrepareActionMode(mode, menu) ?: false
                override fun onActionItemClicked(mode: android.view.ActionMode, item: android.view.MenuItem) = inner?.onActionItemClicked(mode, item) ?: false
                override fun onDestroyActionMode(mode: android.view.ActionMode) { menus--; inner?.onDestroyActionMode(mode) }
            }
            val at = view.editableText.indexOf(word) + 2
            val l = view.layout
            val line = l.getLineForOffset(at)
            (view.totalPaddingLeft + l.getPrimaryHorizontal(at)) to (view.totalPaddingTop - view.scrollY + (l.getLineTop(line) + l.getLineBottom(line)) / 2f)
        }
        val down = SystemClock.uptimeMillis()
        withContext(Dispatchers.Main) { touch(view, down, down, MotionEvent.ACTION_DOWN, x, y) }
        delay(ViewConfiguration.getLongPressTimeout() + 300L)
        withContext(Dispatchers.Main) { touch(view, down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y) }
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { menus == 0 || view.selectionStart == view.selectionEnd }) delay(20) }
    }

    private suspend fun assertCaretOnScreen(c: TextFirstController) = withContext(Dispatchers.Main) {
        val view = c.view
        val l = view.layout
        val line = l.getLineForOffset(view.selectionEnd)
        val top = l.getLineTop(line) + view.totalPaddingTop
        val bottom = l.getLineBottom(line) + view.totalPaddingTop
        assertTrue("the caret's line ($top..$bottom) is on screen (${view.scrollY}..${view.scrollY + view.height})", top >= view.scrollY && bottom <= view.scrollY + view.height)
    }

    @Test fun aPasteFromTheMenuOverAHeldWordRevealsTheCaretAtItsEnd() = textFirstSession(note) { c ->
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { c.view.layout == null }) delay(20) }
        withContext(Dispatchers.Main) { c.view.context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText(null, clip)) }
        holdWithMenu(c, "paragraph")
        assertMenuOpen("the Paste")
        withContext(Dispatchers.Main) { c.view.onTextContextMenuItem(android.R.id.paste) }
        withTimeout(5_000) { while (!(c.sourceText() ?: "").contains("pasted line 200")) delay(20) }
        delay(600)
        assertCaretOnScreen(c)
    }

    /**
     * Sol (round 3): a hardware Ctrl+Z while a word's menu is open closes the menu as the Undo applies. The Undo's
     * caret, at the undone edit far down the note, is revealed (a caret that moved), not held where the menu was.
     */
    @Test fun anUndoWhileAWordsMenuIsOpenRevealsTheUndoneEdit() = textFirstSession(note) { c ->
        val view = c.view
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { view.layout == null }) delay(20) }
        c.select(withContext(Dispatchers.Main) { view.editableText.indexOf("line 20 after") })
        delay(300)
        textFirstIme(c) { commitText("Z", 1) }
        withTimeout(5_000) { while (!(c.sourceText() ?: "").contains("Zline 20")) delay(20) }
        withContext(Dispatchers.Main) { view.scrollTo(0, 0) }
        delay(300)
        holdWithMenu(c, "paragraph")
        assertMenuOpen("the Undo")
        withContext(Dispatchers.Main) {
            for (action in listOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) view.dispatchKeyEvent(KeyEvent(0, 0, action, KeyEvent.KEYCODE_Z, 0, KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON))
        }
        withTimeout(5_000) { while ((c.sourceText() ?: "").contains("Zline 20")) delay(20) }
        delay(600)
        assertCaretOnScreen(c)
    }
}

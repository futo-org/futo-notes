package com.futo.notes.textfirst

import android.content.ClipData
import android.content.ClipboardManager
import android.os.SystemClock
import android.view.InputDevice
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

    @Test fun aPasteFromTheMenuOverAHeldWordRevealsTheCaretAtItsEnd() = textFirstSession(note) { c ->
        val view = c.view
        withContext(Dispatchers.Main) {
            view.isFocusableInTouchMode = true
            view.requestFocus()
        }
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { view.layout == null }) delay(20) }
        val (x, y) = withContext(Dispatchers.Main) {
            view.context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText(null, clip))
            val at = view.editableText.indexOf("paragraph") + 3
            val l = view.layout
            val line = l.getLineForOffset(at)
            (view.totalPaddingLeft + l.getPrimaryHorizontal(at)) to (view.totalPaddingTop - view.scrollY + (l.getLineTop(line) + l.getLineBottom(line)) / 2f)
        }
        val down = SystemClock.uptimeMillis()
        withContext(Dispatchers.Main) { touch(view, down, down, MotionEvent.ACTION_DOWN, x, y) }
        delay(ViewConfiguration.getLongPressTimeout() + 300L)
        withContext(Dispatchers.Main) { touch(view, down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y) }
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { view.selectionStart == view.selectionEnd }) delay(20) }
        delay(500) // the word's menu opens
        withContext(Dispatchers.Main) { view.onTextContextMenuItem(android.R.id.paste) }
        withTimeout(5_000) { while (!(c.sourceText() ?: "").contains("pasted line 200")) delay(20) }
        delay(600)
        withContext(Dispatchers.Main) {
            val l = view.layout
            val line = l.getLineForOffset(view.selectionEnd)
            val top = l.getLineTop(line) + view.totalPaddingTop
            val bottom = l.getLineBottom(line) + view.totalPaddingTop
            assertTrue("the caret's line ($top..$bottom) is on screen (${view.scrollY}..${view.scrollY + view.height})", top >= view.scrollY && bottom <= view.scrollY + view.height)
        }
    }
}

package com.futo.notes.textfirst

import android.content.ClipboardManager
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.ViewConfiguration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Ignore
import org.junit.Test

/**
 * Mason's rules for a list marker on a phone: it acts as one character. A tap on its left half puts the caret before it,
 * on its right half at the item's text; a hold with the keyboard up selects it alone; a checkbox ticks on a tap and is
 * selected, not ticked, by a hold.
 */
class TextFirstListMarkerTouchTest {
    private val note = "- bullet\n  - nested\n10. tenth\n- [ ] task\n- שלום עולם\n\nend"

    private suspend fun await(what: String, done: () -> Boolean) {
        withTimeout(5_000) { while (!done()) delay(20) }.also { check(done()) { "no $what" } }
    }

    private suspend fun awaitSource(c: TextFirstController, what: String, done: (String) -> Boolean) {
        withTimeout(5_000) { while (!done(c.sourceText() ?: "")) delay(20) }
    }

    private suspend fun ready(c: TextFirstController) = withContext(Dispatchers.Main) {
        c.view.isFocusableInTouchMode = true
        c.view.requestFocus()
        await("a layout") { c.view.layout != null && c.view.editableText.getSpans(0, c.view.length(), TfListMarker::class.java).size == 5 }
    }

    /** The marker unit of the line holding [word]: its offset, its run's left and right (view x) and its row's middle (view y). */
    private fun marker(c: TextFirstController, word: String): MarkerRun {
        val view = c.view
        val l = view.layout
        val at = l.getLineStart(l.getLineForOffset(view.editableText.indexOf(word)))
        val left = minOf(l.getPrimaryHorizontal(at), l.getPrimaryHorizontal(at + 1)) + view.totalPaddingLeft
        val width = view.editableText.getSpans(at, at + 1, TfListMarker::class.java).single().width
        val line = l.getLineForOffset(at)
        val y = view.totalPaddingTop - view.scrollY + (l.getLineTop(line) + l.getLineBottom(line)) / 2f
        return MarkerRun(at, left, left + width, y, l.getParagraphDirection(line) < 0)
    }

    private class MarkerRun(val at: Int, val left: Float, val right: Float, val y: Float, val rtl: Boolean)

    private suspend fun hold(c: TextFirstController, x: Float, y: Float) {
        val down = SystemClock.uptimeMillis()
        withContext(Dispatchers.Main) { send(c, down, down, MotionEvent.ACTION_DOWN, x, y) }
        delay(ViewConfiguration.getLongPressTimeout() + 300L)
        withContext(Dispatchers.Main) { send(c, down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y) }
        delay(300)
    }

    private fun send(c: TextFirstController, down: Long, time: Long, action: Int, x: Float, y: Float) {
        val event = MotionEvent.obtain(down, time, action, x, y, 0)
        event.source = InputDevice.SOURCE_TOUCHSCREEN
        try { c.view.dispatchTouchEvent(event) } finally { event.recycle() }
    }

    private suspend fun tap(c: TextFirstController, x: Float, y: Float) {
        withContext(Dispatchers.Main) { tapNoteAt(c.view, x, y) }
        delay(400)
    }

    @Test fun aTapOnEitherHalfOfAMarkerPutsTheCaretOnThatSide() = textFirstSession(note) { c ->
        ready(c)
        for (word in listOf("bullet", "nested", "tenth", "שלום")) {
            val m = withContext(Dispatchers.Main) { marker(c, word) }
            val leftHalf = m.left + (m.right - m.left) * 0.25f
            val rightHalf = m.left + (m.right - m.left) * 0.75f
            // The marker's leading side is its left in a left-to-right item and its right in a right-to-left one.
            tap(c, if (m.rtl) rightHalf else leftHalf, m.y)
            assertEquals("$word: the leading half puts the caret before the marker", m.at to m.at, withContext(Dispatchers.Main) { c.view.selectionStart to c.view.selectionEnd })
            tap(c, if (m.rtl) leftHalf else rightHalf, m.y)
            assertEquals("$word: the trailing half puts the caret at the text", m.at + 1 to m.at + 1, withContext(Dispatchers.Main) { c.view.selectionStart to c.view.selectionEnd })
        }
    }

    @Test fun aHoldOnAMarkerWithTheKeyboardUpSelectsItAndCopiesItsSource() = textFirstSession(note) { c ->
        ready(c)
        val m = withContext(Dispatchers.Main) { marker(c, "tenth") }
        // On its trailing half, where a tap puts the caret at the text: a platform hold there selects the word "tenth".
        hold(c, m.left + (m.right - m.left) * 0.75f, m.y)
        assertEquals("the marker alone is selected", m.at to m.at + 1, withContext(Dispatchers.Main) { c.view.selectionStart to c.view.selectionEnd })
        val copied = withContext(Dispatchers.Main) {
            val clipboard = c.view.context.getSystemService(ClipboardManager::class.java)
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText(null, "old"))
            c.view.onTextContextMenuItem(android.R.id.copy)
            clipboard
        }
        await("the copy") { copied.primaryClip?.getItemAt(0)?.text?.toString() != "old" }
        assertEquals("10. ", copied.primaryClip!!.getItemAt(0).text.toString())
        assertEquals(note, c.sourceText())
    }

    @Test fun aCheckboxTicksOnATapAndIsSelectedNotTickedByAHold() = textFirstSession(note) { c ->
        ready(c)
        val m = withContext(Dispatchers.Main) { marker(c, "task") }
        hold(c, (m.left + m.right) / 2, m.y)
        assertEquals("a hold selects the checkbox", m.at to m.at + 1, withContext(Dispatchers.Main) { c.view.selectionStart to c.view.selectionEnd })
        assertEquals("a hold ticks nothing", note, c.sourceText())
        tap(c, (m.left + m.right) / 2, m.y)
        awaitSource(c, "the tick") { it.contains("- [x] task") }
    }

    /** A text menu already open (a word held first): the platform would take the hold as a drag of the selection. */
    @Test fun aHoldOnAMarkerWithAMenuOpenSelectsTheMarker() = textFirstSession(note) { c ->
        ready(c)
        val (m, word) = withContext(Dispatchers.Main) {
            val m = marker(c, "tenth")
            val l = c.view.layout
            val at = c.view.editableText.indexOf("tenth") + 2
            m to (c.view.totalPaddingLeft + l.getPrimaryHorizontal(at))
        }
        hold(c, word, m.y)
        await("the word's menu") { c.view.renderHold.menuOpen && c.view.selectionStart != c.view.selectionEnd }
        hold(c, m.left + (m.right - m.left) * 0.75f, m.y)
        assertEquals("the marker alone is selected", m.at to m.at + 1, withContext(Dispatchers.Main) { c.view.selectionStart to c.view.selectionEnd })
        await("the menu on it") { c.view.renderHold.menuOpen }
    }

    /** A tap just past the checkbox's outer side ticks it (TextFirstCheckbox reach); a hold there selects it and ticks nothing. */
    @Test fun aHoldJustPastACheckboxSelectsItAndTicksNothing() = textFirstSession(note) { c ->
        ready(c)
        val m = withContext(Dispatchers.Main) { marker(c, "task") }
        val outside = m.left - c.view.style.dp(4f)
        assertEquals("the reach is the checkbox's", m.at, withContext(Dispatchers.Main) { checkboxAt(c.view, c.view.style, outside, m.y) })
        hold(c, outside, m.y)
        assertEquals("the checkbox is selected", m.at to m.at + 1, withContext(Dispatchers.Main) { c.view.selectionStart to c.view.selectionEnd })
        assertEquals("a hold ticks nothing", note, c.sourceText())
    }

    @Test fun backspaceRightAfterAMarkerLeavesAPlainLine() = textFirstSession(note) { c ->
        ready(c)
        val at = withContext(Dispatchers.Main) { marker(c, "tenth").at }
        c.select(at + 1)
        await("the caret at the text") { c.view.selectionStart == at + 1 }
        textFirstIme(c) { deleteSurroundingText(1, 0) }
        awaitSource(c, "the marker gone") { it.contains("\ntenth\n") }
    }

    @Test fun aMarkerIsDrawnOnceInItsOwnColumn() = textFirstSession(note) { c ->
        ready(c)
        val (shot, rows) = withContext(Dispatchers.Main) {
            val view = c.view
            val bitmap = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
            view.draw(android.graphics.Canvas(bitmap))
            bitmap to listOf(marker(c, "nested"), marker(c, "bullet"))
        }
        try {
            val background = shot.getPixel(1, rows[0].y.toInt())
            val nested = rows[0]
            // Nothing in the nested item's indent before its marker column: the margin draws no second marker.
            for (x in c.view.totalPaddingLeft + 2 until nested.left.toInt() - 2) for (dy in -8..8 step 4) {
                assertEquals("indent pixel $x", background, shot.getPixel(x, nested.y.toInt() + dy))
            }
            // Ink inside each marker's own column.
            for (m in rows) {
                var ink = 0
                for (x in m.left.toInt() until m.right.toInt()) for (dy in -12..12 step 2) if (shot.getPixel(x, m.y.toInt() + dy) != background) ink++
                assertTrue("the marker at ${m.at} is drawn in its column", ink > 0)
            }
        } finally { shot.recycle() }
    }

    @Ignore("Engine: ToggleTask moves a caret before the marker to the item's text (Draft::map, draft.rs:121-141); sent to the desktop chat")
    @Test fun aTickWhileTheCaretIsBeforeAMarkerKeepsTheCaret() = textFirstSession(note) { c ->
        ready(c)
        val m = withContext(Dispatchers.Main) { marker(c, "task") }
        c.select(m.at)
        await("the caret before the marker") { c.view.selectionStart == m.at }
        tap(c, (m.left + m.right) / 2, m.y)
        awaitSource(c, "the tick") { it.contains("- [x] task") }
        assertEquals("the caret stays before the marker", m.at to m.at, withContext(Dispatchers.Main) { c.view.selectionStart to c.view.selectionEnd })
    }
}

package com.futo.notes.textfirst

import android.os.Bundle
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.accessibility.AccessibilityNodeInfo
import java.text.BreakIterator
import kotlin.math.hypot

/**
 * A third quick tap in one place selects the whole line under the finger. Android's own double-tap picks
 * the word and has no third step, so the first two taps stay the platform's (caret, then word) and this
 * claims only the third, keeping the platform from re-selecting the word over the line.
 *
 * The double-tap is the platform's only where the platform does it: Samsung's One UI 8.5 (Android 16)
 * text view left a bare caret, where AOSP and Pixels select the word. After a second tap this checks,
 * once the platform has handled it and again once its delayed selection work is done, and selects the
 * tapped word itself if all that is left is a caret inside it.
 */
internal class LineSelectTouch(private val view: TextFirstEditText) {
    private val config = ViewConfiguration.get(view.context)
    private var taps = 0
    private var lastUp = 0L
    private var lastX = 0f
    private var lastY = 0f
    private var downX = 0f
    private var downY = 0f
    private var moved = false
    private var claimed = false
    /** The word the last double-tap landed on, until it is checked or a new touch begins. */
    private var word: IntRange? = null
    private val checkWord = Runnable { ensureWordSelected() }

    fun onTouch(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                cancelWordCheck()
                downX = event.x
                downY = event.y
                moved = false
                claimed = taps >= 2 && continues(event)
            }
            MotionEvent.ACTION_MOVE -> if (far(event.x, event.y, downX, downY, config.scaledTouchSlop)) moved = true
            MotionEvent.ACTION_POINTER_DOWN -> moved = true
            MotionEvent.ACTION_CANCEL -> { claimed = false; taps = 0 }
            MotionEvent.ACTION_UP -> {
                val tap = !moved && !far(event.x, event.y, downX, downY, config.scaledTouchSlop) &&
                    event.eventTime - event.downTime < ViewConfiguration.getLongPressTimeout()
                val third = claimed
                claimed = false
                if (third) {
                    taps = 0
                    if (tap) selectLine(event.x, event.y)
                    return true
                }
                taps = when {
                    !tap -> 0
                    taps > 0 && continues(event) -> taps + 1
                    else -> 1
                }
                lastUp = event.eventTime
                lastX = event.x
                lastY = event.y
                if (taps == 2) scheduleWordCheck(event.x, event.y)
            }
        }
        return claimed
    }

    /** This touch begins soon enough after the last tap lifted, and near enough to it, to be its next tap. */
    private fun continues(event: MotionEvent) =
        event.downTime - lastUp <= ViewConfiguration.getDoubleTapTimeout() &&
            !far(downX, downY, lastX, lastY, config.scaledDoubleTapSlop)

    private fun far(x: Float, y: Float, fromX: Float, fromY: Float, limit: Int) = hypot(x - fromX, y - fromY) > limit

    private fun cancelWordCheck() {
        word = null
        view.removeCallbacks(checkWord)
    }

    /** After the platform has seen this lift (the view posts run after it), and again once a third tap can no longer come. */
    private fun scheduleWordCheck(x: Float, y: Float) {
        word = wordAt(x, y) ?: return
        view.post(checkWord)
        view.postDelayed(checkWord, ViewConfiguration.getDoubleTapTimeout() + WORD_SETTLE_MS)
    }

    private fun ensureWordSelected() {
        val range = word ?: return
        val a = view.selectionStart
        val b = view.selectionEnd
        if (a != b || a < range.first || a > range.last + 1) return
        val text = view.editableText ?: return
        if (range.last >= text.length) return
        android.util.Log.i(TAG, "double-tap left caret $a; selecting word ${range.first}-${range.last + 1}")
        select(range.first, range.last + 1)
    }

    /** The word (letters or digits) under the point, as an inclusive range; null over spaces and punctuation. */
    private fun wordAt(x: Float, y: Float): IntRange? {
        val text = view.editableText ?: return null
        val last = (text.length - 1).coerceAtLeast(0)
        if (last == 0) return null
        val at = view.getOffsetForPosition(x, y).coerceIn(0, last)
        var lineStart = at
        while (lineStart > 0 && text[lineStart - 1] != '\n') lineStart--
        var lineEnd = at
        while (lineEnd < last && text[lineEnd] != '\n') lineEnd++
        if (lineStart == lineEnd) return null
        val line = text.subSequence(lineStart, lineEnd).toString()
        val words = BreakIterator.getWordInstance(view.textLocale)
        words.setText(line)
        // The offset is the nearest caret stop: on a letter's right half that is the
        // letter after it, so step back to the character actually under the finger.
        val layout = view.layout ?: return null
        val localX = x - view.totalPaddingLeft + view.scrollX
        val under = (if (at > lineStart && localX < layout.getPrimaryHorizontal(at)) at - 1 else at) - lineStart
        if (under < 0 || under >= line.length) return null
        val end = words.following(under)
        val start = words.previous()
        if (start == BreakIterator.DONE || end == BreakIterator.DONE || start >= end) return null
        if (line.substring(start, end).none(Char::isLetterOrDigit)) return null
        return (lineStart + start) until (lineStart + end)
    }

    /** The text between the line breaks around the point: a wrapped paragraph is one line. */
    private fun selectLine(x: Float, y: Float) {
        val text = view.editableText ?: return
        // The end sentinel is not a caret position.
        val last = (text.length - 1).coerceAtLeast(0)
        val at = view.getOffsetForPosition(x, y).coerceIn(0, last)
        var start = at
        while (start > 0 && text[start - 1] != '\n') start--
        var end = at
        while (end < last && text[end] != '\n') end++
        select(start, end)
    }

    private fun select(start: Int, end: Int) {
        // This public TextView action also starts the platform's selection
        // action mode (handles and callout); setSelection alone only paints a range.
        view.requestFocus()
        view.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, end)
        })
    }

    private companion object {
        const val TAG = "TextFirstTap"
        /** Past the double-tap window: AOSP's smart-selection animation has finished by then. */
        const val WORD_SETTLE_MS = 150L
    }
}

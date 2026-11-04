package com.futo.notes.textfirst

import android.os.Bundle
import android.os.Handler
import android.text.TextUtils
import android.view.KeyEvent
import android.view.inputmethod.CompletionInfo
import android.view.inputmethod.CorrectionInfo
import android.view.inputmethod.ExtractedText
import android.view.inputmethod.ExtractedTextRequest
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputContentInfo
import uniffi.futo_notes_ffi.EditorParagraphKey

/**
 * The keyboard's connection, dispatched on the editor thread through
 * [getHandler] (the same arrangement Chromium's threaded input uses). Reads
 * come from the engine's display mirror, which already holds every accepted
 * change and the marked text; writes go to the engine, which applies them to
 * the mirror before the view ever sees them, so nothing the keyboard sends can
 * run ahead of the engine's acceptance.
 *
 * Methods that need the view (context-menu actions, hardware-style key events
 * that move the caret) are forwarded to the UI thread through [view].
 */
internal class EngineInputConnection(
    private val engine: EditorEngine,
    private val view: ViewSide,
    private val cell: Boolean = false,
) : InputConnection {
    interface ViewSide {
        fun contextMenuAction(id: Int)
        fun navigationKey(event: KeyEvent)
        fun imageContent(info: InputContentInfo, flags: Int): Boolean

        /** The image or code block a tap selected as one object, while that is still the whole selection. */
        val selectedObject: Pair<Int, Int>? get() = null
    }

    private var batch = 0
    private val low: Int get() = if (cell) engine.cellRange?.first ?: engine.selStart else 0
    private val high: Int get() = if (cell) engine.cellRange?.last ?: engine.selEnd else engine.text.length

    /** Debug: every keyboard call, with the caret it saw, under `TextFirstIme`. */
    private fun trace(call: String) {
        if (com.futo.notes.BuildConfig.DEBUG) {
            val text = engine.text
            val at = engine.selStart.coerceIn(0, text.length)
            val around = text.substring(maxOf(0, at - 12), at).replace("\n", "⏎")
            android.util.Log.d("TextFirstIme", "$call  sel=${engine.selStart}..${engine.selEnd} before=\"$around\"")
        }
    }

    override fun getHandler(): Handler = engine.handler

    override fun getTextBeforeCursor(n: Int, flags: Int): CharSequence {
        trace("getTextBeforeCursor(" + "n=" + n + ")")
        val text = engine.text
        val end = engine.selStart.coerceIn(0, text.length)
        return text.substring(maxOf(low, end - n), end)
    }

    override fun getTextAfterCursor(n: Int, flags: Int): CharSequence {
        val text = engine.text
        val start = engine.selEnd.coerceIn(0, text.length)
        return text.substring(start, minOf(high, start + n))
    }

    override fun getSelectedText(flags: Int): CharSequence? {
        val text = engine.text
        if (engine.selStart == engine.selEnd) return null
        return text.substring(engine.selStart.coerceIn(0, text.length), engine.selEnd.coerceIn(0, text.length))
    }

    override fun getCursorCapsMode(reqModes: Int): Int =
        if (cell) TextUtils.getCapsMode(engine.text.subSequence(low, high), (engine.selStart - low).coerceIn(0, high - low), reqModes)
        else TextUtils.getCapsMode(engine.text, engine.selStart.coerceIn(0, engine.text.length), reqModes)

    override fun getExtractedText(request: ExtractedTextRequest?, flags: Int): ExtractedText? {
        // Full-screen extract mode is off (flagNoExtractUi); keyboards that ask
        // anyway get a window around the caret rather than a 500 KB copy.
        val text = engine.text
        val from = maxOf(low, engine.selStart - EXTRACT_WINDOW)
        val to = minOf(high, engine.selEnd + EXTRACT_WINDOW)
        return ExtractedText().apply {
            this.text = text.substring(from, to)
            startOffset = from - low
            partialStartOffset = -1
            partialEndOffset = -1
            selectionStart = engine.selStart - from
            selectionEnd = engine.selEnd - from
        }
    }

    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        if (cell && !engine.editingCell) return true
        trace("deleteSurroundingText(" + "beforeLength=" + beforeLength + " " + "afterLength=" + afterLength + ")")
        engine.imeDeleteSurrounding(minOf(beforeLength, engine.selStart - low), minOf(afterLength, high - engine.selEnd))
        return true
    }

    override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
        if (cell && !engine.editingCell) return true
        trace("deleteSurroundingTextInCodePoints(" + "beforeLength=" + beforeLength + " " + "afterLength=" + afterLength + ")")
        val text = engine.text
        var before = 0
        var at = engine.selStart
        repeat(beforeLength) {
            if (at <= low) return@repeat
            val step = if (at >= 2 && Character.isLowSurrogate(text[at - 1]) && Character.isHighSurrogate(text[at - 2])) 2 else 1
            at -= step; before += step
        }
        var after = 0
        at = engine.selEnd
        repeat(afterLength) {
            if (at >= high) return@repeat
            val step = if (at + 1 < text.length && Character.isHighSurrogate(text[at]) && Character.isLowSurrogate(text[at + 1])) 2 else 1
            at += step; after += step
        }
        engine.imeDeleteSurrounding(before, after)
        return true
    }

    override fun setComposingText(text: CharSequence, newCursorPosition: Int): Boolean {
        if (cell && !engine.editingCell) return true
        trace("setComposingText(" + "text=" + text + " " + "newCursorPosition=" + newCursorPosition + ")")
        engine.imeSetComposing(text.toString())
        return true
    }

    override fun setComposingRegion(start: Int, end: Int): Boolean {
        if (cell && !engine.editingCell) return true
        trace("setComposingRegion(" + "start=" + start + " " + "end=" + end + ")")
        engine.imeSetComposingRegion((low + start).coerceIn(low, high), (low + end).coerceIn(low, high))
        return true
    }

    override fun finishComposingText(): Boolean {
        trace("finishComposingText(" + "" + ")")
        engine.imeFinishComposing()
        return true
    }

    override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
        if (cell && !engine.editingCell) return true
        trace("commitText(" + "text=" + text + " " + "newCursorPosition=" + newCursorPosition + ")")
        engine.imeCommit(text.toString())
        return true
    }

    override fun commitCompletion(text: CompletionInfo): Boolean {
        if (cell && !engine.editingCell) return true
        text.text?.let { engine.imeCommit(it.toString()) }
        return true
    }

    override fun commitCorrection(correctionInfo: CorrectionInfo?): Boolean = true

    override fun setSelection(start: Int, end: Int): Boolean {
        if (cell && !engine.editingCell) return true
        trace("setSelection(" + "start=" + start + " " + "end=" + end + ")")
        // Enter on a selection makes the keyboard collapse it and delete the
        // selected text first. A selected image or code block takes Enter as an
        // object (the engine acts after it), so that collapse is not passed on.
        if (!cell && start == end) {
            val selected = view.selectedObject
            if (selected != null && selected.first == engine.selStart && selected.second == engine.selEnd && start == selected.second) return true
        }
        engine.imeSetSelection((low + start).coerceIn(low, high), (low + end).coerceIn(low, high))
        return true
    }

    override fun performEditorAction(editorAction: Int): Boolean {
        trace("performEditorAction(" + "editorAction=" + editorAction + ")")
        if (cell) engine.finishCellEditing() else engine.key(EditorParagraphKey.ENTER)
        return true
    }

    override fun performContextMenuAction(id: Int): Boolean {
        view.contextMenuAction(id)
        return true
    }

    override fun beginBatchEdit(): Boolean { batch += 1; return true }
    override fun endBatchEdit(): Boolean { batch = maxOf(0, batch - 1); return batch > 0 }

    override fun sendKeyEvent(event: KeyEvent): Boolean {
        if (cell && !engine.editingCell) return true
        trace("sendKeyEvent(" + "event.action=" + event.action + " " + "event.keyCode=" + event.keyCode + ")")
        if (event.action != KeyEvent.ACTION_DOWN) return true
        if (cell && event.keyCode in listOf(KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER, KeyEvent.KEYCODE_TAB)) {
            engine.finishCellEditing(); return true
        }
        if (cell && event.keyCode == KeyEvent.KEYCODE_DEL && engine.selStart == low && engine.selEnd == low) return true
        if (cell && event.keyCode == KeyEvent.KEYCODE_FORWARD_DEL && engine.selStart == high && engine.selEnd == high) return true
        when (event.keyCode) {
            KeyEvent.KEYCODE_DEL -> engine.key(EditorParagraphKey.BACKSPACE)
            KeyEvent.KEYCODE_FORWARD_DEL -> engine.key(EditorParagraphKey.DELETE)
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER ->
                engine.key(if (event.isShiftPressed) EditorParagraphKey.SHIFT_ENTER else EditorParagraphKey.ENTER)
            KeyEvent.KEYCODE_TAB -> engine.key(if (event.isShiftPressed) EditorParagraphKey.SHIFT_TAB else EditorParagraphKey.TAB)
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_UP,
            KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_MOVE_HOME, KeyEvent.KEYCODE_MOVE_END,
            KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_PAGE_DOWN -> view.navigationKey(event)
            else -> {
                val char = event.unicodeChar
                if (char != 0) engine.imeCommit(String(Character.toChars(char)))
            }
        }
        return true
    }

    override fun clearMetaKeyStates(states: Int): Boolean = true
    override fun reportFullscreenMode(enabled: Boolean): Boolean = true
    override fun performPrivateCommand(action: String?, data: Bundle?): Boolean = false
    override fun requestCursorUpdates(cursorUpdateMode: Int): Boolean = false
    override fun closeConnection() { engine.imeFinishComposing() }
    override fun commitContent(inputContentInfo: InputContentInfo, flags: Int, opts: Bundle?): Boolean = view.imageContent(inputContentInfo, flags)

    private companion object {
        const val EXTRACT_WINDOW = 2_000
    }
}

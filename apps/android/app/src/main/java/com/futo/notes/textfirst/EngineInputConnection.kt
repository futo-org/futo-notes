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
internal open class EngineInputConnection(
    protected val engine: EditorEngine,
    private val view: ViewSide,
    private val cell: Boolean = false,
) : InputConnection {
    interface ViewSide {
        fun contextMenuAction(id: Int)
        fun navigationKey(event: KeyEvent)
        fun imageContent(info: InputContentInfo, flags: Int): Boolean

        /** The image or code block a tap selected as one object, while that is still the whole selection. */
        val selectedObject: Pair<Int, Int>? get() = null
        /** The native clipped range, for rejecting only its stale IME echo. */
        val renderedSelection: Long get() = Long.MIN_VALUE
    }

    private var batch = 0
    private data class Collapse(val seq: Int, val revision: ULong, val start: Int, val end: Int, val at: Int)
    private var collapse: Collapse? = null

    /** Gboard deletes a selection as one batch: collapse to its end, then delete backwards. */
    private fun selectedDeletion(before: Int, after: Int, codePoints: Boolean = false): Boolean {
        val pending = collapse ?: return false
        val unchanged = pending.revision == engine.rev && pending.start == engine.selStart && pending.end == engine.selEnd
        val length = if (unchanged && codePoints) Character.codePointCount(engine.text, pending.start, pending.end)
            else pending.end - pending.start
        val backwards = pending.at == pending.end && before == length && after == 0
        val forwards = pending.at == pending.start && before == 0 && after == length
        if (!unchanged || (!backwards && !forwards)) return false
        collapse = null
        engine.key(if (backwards) EditorParagraphKey.BACKSPACE else EditorParagraphKey.DELETE)
        return true
    }

    private fun flushCollapse() {
        val pending = collapse ?: return
        collapse = null
        engine.selectFromView(pending.seq, pending.at, pending.at, force = true)
    }
    private val low: Int get() = if (cell) engine.cellRange?.first ?: engine.selStart else 0
    private val high: Int get() = if (cell) engine.cellRange?.last ?: engine.selEnd else engine.text.length

    /** Debug: every keyboard call, with the caret it saw, under `TextFirstIme`. */
    private fun trace(call: String) {
        if (com.futo.notes.BuildConfig.DEBUG) {
            android.util.Log.d("TextFirstIme", "$call sel=${engine.selStart}..${engine.selEnd} length=${engine.text.length}")
        }
    }

    override fun getHandler(): Handler = engine.handler

    override fun getTextBeforeCursor(n: Int, flags: Int): CharSequence {
        flushCollapse()
        require(n >= 0)
        trace("getTextBeforeCursor(" + "n=" + n + ")")
        val text = engine.text
        val end = engine.selStart.coerceIn(0, text.length)
        return imeTextBefore(text, end, low, n)
    }

    override fun getTextAfterCursor(n: Int, flags: Int): CharSequence {
        flushCollapse()
        require(n >= 0)
        val text = engine.text
        val start = engine.selEnd.coerceIn(0, text.length)
        return imeTextAfter(text, start, high, n)
    }

    override fun getSelectedText(flags: Int): CharSequence? {
        flushCollapse()
        val text = engine.text
        if (engine.selStart == engine.selEnd) return null
        if (engine.selEnd - engine.selStart > IME_SELECTED_CHARS) return null
        return text.substring(engine.selStart.coerceIn(0, text.length), engine.selEnd.coerceIn(0, text.length))
    }

    override fun getCursorCapsMode(reqModes: Int): Int {
        flushCollapse()
        return if (cell) TextUtils.getCapsMode(engine.text.subSequence(low, high), (engine.selStart - low).coerceIn(0, high - low), reqModes)
        else TextUtils.getCapsMode(engine.text, engine.selStart.coerceIn(0, engine.text.length), reqModes)
    }

    override fun getExtractedText(request: ExtractedTextRequest?, flags: Int): ExtractedText? {
        flushCollapse()
        // Never parcel a whole giant selection or pretend it is collapsed.
        val context = contextWindow(IME_CONTEXT_CHARS, IME_CONTEXT_CHARS) ?: return null
        return ExtractedText().apply {
            this.text = context.text
            startOffset = context.start
            partialStartOffset = -1
            partialEndOffset = -1
            selectionStart = context.selectionStart
            selectionEnd = context.selectionEnd
        }
    }

    protected fun contextWindow(before: Int, after: Int): ImeContextWindow? {
        flushCollapse()
        return ImeContextWindow.capture(engine.text, engine.selStart, engine.selEnd, low, high, before, after)
    }

    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        if (cell && !engine.editingCell) return true
        if (selectedDeletion(beforeLength, afterLength)) return true
        flushCollapse()
        trace("deleteSurroundingText(" + "beforeLength=" + beforeLength + " " + "afterLength=" + afterLength + ")")
        engine.imeDeleteSurrounding(minOf(beforeLength, engine.selStart - low), minOf(afterLength, high - engine.selEnd))
        return true
    }

    override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
        if (cell && !engine.editingCell) return true
        if (selectedDeletion(beforeLength, afterLength, codePoints = true)) return true
        flushCollapse()
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
        flushCollapse()
        if (cell && !engine.editingCell) return true
        trace("setComposingText(" + "textLength=" + text.length + " " + "newCursorPosition=" + newCursorPosition + ")")
        engine.imeSetComposing(text.toString())
        return true
    }

    override fun setComposingRegion(start: Int, end: Int): Boolean {
        flushCollapse()
        if (cell && !engine.editingCell) return true
        trace("setComposingRegion(" + "start=" + start + " " + "end=" + end + ")")
        engine.imeSetComposingRegion((low + start).coerceIn(low, high), (low + end).coerceIn(low, high))
        return true
    }

    override fun finishComposingText(): Boolean {
        flushCollapse()
        trace("finishComposingText(" + "" + ")")
        engine.imeFinishComposing()
        return true
    }

    override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
        flushCollapse()
        if (cell && !engine.editingCell) return true
        trace("commitText(" + "textLength=" + text.length + " " + "newCursorPosition=" + newCursorPosition + ")")
        engine.imeCommit(text.toString())
        return true
    }

    override fun commitCompletion(text: CompletionInfo): Boolean {
        flushCollapse()
        if (cell && !engine.editingCell) return true
        text.text?.let { engine.imeCommit(it.toString()) }
        return true
    }

    override fun commitCorrection(correctionInfo: CorrectionInfo?): Boolean = true

    override fun setSelection(start: Int, end: Int): Boolean {
        flushCollapse()
        if (cell && !engine.editingCell) return true
        trace("setSelection(" + "start=" + start + " " + "end=" + end + ")")
        if (!cell) {
            val requested = (start.toLong() shl 32) or (end.toLong() and 0xffffffffL)
            val logical = (engine.selStart.toLong() shl 32) or (engine.selEnd.toLong() and 0xffffffffL)
            if (requested == view.renderedSelection && requested != logical) return true
        }
        // Enter on a selection makes the keyboard collapse it and delete the
        // selected text first. A selected image or code block takes Enter as an
        // object (the engine acts after it), so that collapse is not passed on.
        val from = (low + start).coerceIn(low, high)
        val to = (low + end).coerceIn(low, high)
        if (start == end) {
            val selected = if (cell) null else view.selectedObject
            if (selected != null && selected.first == engine.selStart && selected.second == engine.selEnd && from == selected.second) return true
            if (batch > 0 && engine.mirror.overlay == null && engine.selStart != engine.selEnd &&
                (from == engine.selStart || from == engine.selEnd)) {
                collapse = Collapse(engine.seq, engine.rev, engine.selStart, engine.selEnd, from)
                return true
            }
        }
        engine.imeSetSelection(from, to)
        return true
    }

    override fun performEditorAction(editorAction: Int): Boolean {
        flushCollapse()
        trace("performEditorAction(" + "editorAction=" + editorAction + ")")
        if (cell) engine.finishCellEditing() else engine.key(EditorParagraphKey.ENTER)
        return true
    }

    override fun performContextMenuAction(id: Int): Boolean {
        flushCollapse()
        view.contextMenuAction(id)
        return true
    }

    override fun beginBatchEdit(): Boolean { batch += 1; return true }
    override fun endBatchEdit(): Boolean {
        batch = maxOf(0, batch - 1)
        if (batch == 0) flushCollapse()
        return batch > 0
    }

    override fun sendKeyEvent(event: KeyEvent): Boolean {
        flushCollapse()
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
    override fun closeConnection() { flushCollapse(); engine.imeFinishComposing() }
    override fun commitContent(inputContentInfo: InputContentInfo, flags: Int, opts: Bundle?): Boolean = view.imageContent(inputContentInfo, flags)

}

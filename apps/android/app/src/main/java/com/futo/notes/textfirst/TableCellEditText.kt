package com.futo.notes.textfirst

import android.content.Context
import android.text.InputFilter
import android.text.InputType
import android.text.Selection
import android.text.Spanned
import android.text.style.UnderlineSpan
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import androidx.appcompat.widget.AppCompatEditText

/** A cell-sized native window onto the SAME session as the note. It never edits its Editable itself. */
internal class TableCellEditText(context: Context, private val editor: EditorEngine, style: TextFirstStyle) :
    AppCompatEditText(context), EngineInputConnection.ViewSide {
    private var applying = false
    private var current: CellUpdate? = null
    /** This field and the painted note must describe the same session and applied frame. */
    fun placementTarget(note: TextFirstEditText): CellUpdate? = current?.takeIf {
        note.engine === editor && note.appliedSeq == it.viewSeq
    }
    private var header = false
    private var cellRuns: List<CellRun> = emptyList()
    private var runShift = 0
    /** Opens a link tapped in the open cell (the note's opener); false when it cannot be opened. */
    var openLink: (CellRun) -> Boolean = { false }
    val update: CellUpdate? get() = current
    private var pressedLink: CellRun? = null
    private var downX = 0f
    private var downY = 0f
    /** The text changed under the styling last set: the host styles it again. */
    var styleStale = true; private set
    fun applyGeometry(geometry: TableCellGeometry) {
        typeface = if (geometry.header) noteStyle.semibold else noteStyle.regular
        centreLetters()
        if (header != geometry.header) { header = geometry.header; updateColors() }
        applyRuns(geometry.runs, geometry.runShift)
        styleStale = false
        gravity = android.view.Gravity.CENTER_VERTICAL or android.view.Gravity.START
        textAlignment = when (geometry.alignment) {
            uniffi.futo_notes_ffi.EditorTableAlignment.RIGHT -> TEXT_ALIGNMENT_TEXT_END
            uniffi.futo_notes_ffi.EditorTableAlignment.CENTER -> TEXT_ALIGNMENT_CENTER
            else -> TEXT_ALIGNMENT_TEXT_START
        }
    }
    private val noteStyle = style
    init {
        updateColors()
        textSize = style.textSizePx / resources.displayMetrics.scaledDensity
        typeface = style.regular
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
        // Enter is the table's key (the cell below, a new row on the last), never a Done action.
        imeOptions = EditorInfo.IME_ACTION_NONE or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        centreLetters()
        includeFontPadding = false
        filters = arrayOf(InputFilter { _, _, _, dest, a, b -> if (applying) null else dest.subSequence(a, b) })
        importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO
    }
    /** Centred on its letters as seen in its face (a header's semibold), where the grid draws them, not on its font box. */
    private fun centreLetters() {
        val pad = noteStyle.dp(10f).toInt()
        val lift = kotlin.math.round(lettersBelowFontBoxCentre(paint)).toInt()
        setPadding(pad, pad - lift, pad, pad + lift)
    }
    fun updateColors() {
        setTextColor(noteStyle.textColor)
        highlightColor = noteStyle.selectionColor
        tintCaretAndSelectionHandles(noteStyle.linkColor)
        // The note's own background with an accent outline; a header cell keeps the header fill.
        background = android.graphics.drawable.GradientDrawable().apply {
            setColor(if (header) noteStyle.codeBackground else noteStyle.pageColor)
            setStroke(noteStyle.dp(2f).toInt(), noteStyle.linkColor)
        }
    }

    /** The engine's inline styling over the field's text, the same runs the closed grid draws. */
    private fun applyRuns(runs: List<CellRun>, shift: Int) {
        cellRuns = runs; runShift = shift
        val e = editableText
        applying = true
        try {
            for (span in e.getSpans(0, e.length, TfSpan::class.java)) e.removeSpan(span)
            val styled = styledCellText(noteStyle, e.toString(), runs, shift)
            for (span in styled.getSpans(0, styled.length, TfSpan::class.java)) {
                e.setSpan(span, styled.getSpanStart(span), styled.getSpanEnd(span), styled.getSpanFlags(span))
            }
        } finally { applying = false }
    }
    override fun isSuggestionsEnabled() = false
    // A cell is note text, never a form field: no "Autofill" item over its selection menu.
    override fun getAutofillType() = AUTOFILL_TYPE_NONE
    fun apply(update: CellUpdate) {
        val previous = current
        val sameWindow = previous?.let { it.start == update.start && it.end == update.end && it.text == update.text } == true
        val sameText = text.toString() == update.text
        val moved = previous != null && (previous.rowStart != update.rowStart || previous.column != update.column)
        current = update
        if (!sameText) styleStale = true
        applying = true
        try {
            if (!sameText) replaceDiff(update.text)
            val e = editableText
            e.getSpans(0, e.length, UnderlineSpan::class.java).forEach(e::removeSpan)
            // The composing range is the engine's, in the window's offsets: clamped, so a window that came out shorter never throws.
            val composeStart = update.composingStart.coerceIn(0, e.length)
            val composeEnd = update.composingEnd.coerceIn(0, e.length)
            if (update.composingStart >= 0 && composeEnd > composeStart) {
                e.setSpan(UnderlineSpan(), composeStart, composeEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE or Spanned.SPAN_COMPOSING)
            }
            val start = update.selectionStart.coerceIn(0, e.length)
            val end = update.selectionEnd.coerceIn(0, e.length)
            // An identical normalized echo must not reverse Shift's native anchor/focus.
            if (!sameWindow || !sameText || minOf(selectionStart, selectionEnd) != minOf(start, end) ||
                maxOf(selectionStart, selectionEnd) != maxOf(start, end)) Selection.setSelection(e, start, end)
        } finally { applying = false }
        // The app moved the caret to another cell: the keyboard re-reads its context (capitalisation, suggestions).
        if (moved) restartKeyboard()
    }

    /** Rewrite only what differs, so the keyboard's spans, the composing mark and the caret outside it survive. */
    private fun replaceDiff(next: String) {
        val e = editableText
        val old = e.toString()
        var prefix = 0
        val most = minOf(old.length, next.length)
        while (prefix < most && old[prefix] == next[prefix]) prefix++
        if (prefix > 0 && Character.isHighSurrogate(old[prefix - 1])) prefix--
        var suffix = 0
        while (suffix < most - prefix && old[old.length - 1 - suffix] == next[next.length - 1 - suffix]) suffix++
        if (suffix > 0 && Character.isLowSurrogate(old[old.length - suffix])) suffix--
        e.replace(prefix, old.length - suffix, next, prefix, next.length - suffix)
    }
    /** The link whose glyphs hold the point: a short tap on it opens it, with no caret move and no delay. */
    private fun linkAt(x: Float, y: Float): CellRun? {
        val l = layout ?: return null
        val lx = x - totalPaddingLeft + scrollX
        val ly = y - totalPaddingTop + scrollY
        if (ly < 0 || ly >= l.height) return null
        val line = l.getLineForVertical(ly.toInt())
        if (lx < l.getLineLeft(line) || lx > l.getLineRight(line)) return null
        val lineRegion = android.graphics.Region(0, l.getLineTop(line), l.width + 1, l.getLineBottom(line))
        val path = android.graphics.Path()
        for (run in cellRuns) {
            if (run.link == null && !(run.wiki && run.noteId != null)) continue
            val a = maxOf(run.start + runShift, l.getLineStart(line)).coerceIn(0, text!!.length)
            val b = minOf(run.end + runShift, l.getLineVisibleEnd(line)).coerceIn(0, text!!.length)
            if (a >= b) continue
            path.reset()
            l.getSelectionPath(a, b, path)
            val region = android.graphics.Region()
            region.setPath(path, lineRegion)
            if (region.contains(lx.toInt(), ly.toInt())) return run
        }
        return null
    }

    /**
     * The part of the field the table has scrolled out of view is not drawn and takes no touch: a press there goes to
     * the note under it, where a pan from the margin is the table's.
     */
    override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
        if (event.actionMasked == android.view.MotionEvent.ACTION_DOWN) {
            val clip = clipBounds
            if (clip != null && !clip.contains(event.x.toInt(), event.y.toInt())) return false
        }
        return super.dispatchTouchEvent(event)
    }

    override fun onTouchEvent(event: android.view.MotionEvent): Boolean {
        when (event.actionMasked) {
            android.view.MotionEvent.ACTION_DOWN -> { pressedLink = linkAt(event.x, event.y); downX = event.x; downY = event.y }
            android.view.MotionEvent.ACTION_MOVE -> {
                val slop = android.view.ViewConfiguration.get(context).scaledTouchSlop
                if (kotlin.math.abs(event.x - downX) > slop || kotlin.math.abs(event.y - downY) > slop) pressedLink = null
            }
            android.view.MotionEvent.ACTION_POINTER_DOWN -> pressedLink = null
            android.view.MotionEvent.ACTION_UP -> {
                val link = pressedLink
                pressedLink = null
                if (link != null && event.eventTime - event.downTime < android.view.ViewConfiguration.getLongPressTimeout() &&
                    linkAt(event.x, event.y) == link && openLink(link)) {
                    cancelLongPress()
                    val cancel = android.view.MotionEvent.obtain(event)
                    cancel.action = android.view.MotionEvent.ACTION_CANCEL
                    try { super.onTouchEvent(cancel) } finally { cancel.recycle() }
                    return true
                }
            }
            android.view.MotionEvent.ACTION_CANCEL -> pressedLink = null
        }
        return super.onTouchEvent(event)
    }

    override fun onSelectionChanged(a: Int, b: Int) {
        super.onSelectionChanged(a, b)
        if (!applying) current?.let { editor.hostSelect(it.start + a.coerceAtLeast(0), it.start + b.coerceAtLeast(0)) }
    }
    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        if (hasWindowFocus && isFocused) context.getSystemService(InputMethodManager::class.java).showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
    }
    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        super.onCreateInputConnection(outAttrs)
        // Android adds IME_FLAG_NO_ENTER_ACTION for a multiline field: Enter stays a key, and Rust owns it.
        outAttrs.initialSelStart = selectionStart; outAttrs.initialSelEnd = selectionEnd
        return engineInputConnection(editor, this, cell = true)
    }
    // A cell holds inline text only: with no image owner, an image paste is refused, never pasted as its URI.
    val clipboard = TextFirstClipboard(context, { e -> e.command { e.cellRange?.let { range -> e.select(range.first, range.last, false) } } }) { editor }
    override fun onTextContextMenuItem(id: Int): Boolean = clipboard.handle(id) || super.onTextContextMenuItem(id)
    override fun contextMenuAction(id: Int) { post { onTextContextMenuItem(id) } }
    override fun imageContent(info: android.view.inputmethod.InputContentInfo, flags: Int) = false
    override fun navigationKey(event: KeyEvent) {
        post {
            when (event.action) {
                KeyEvent.ACTION_DOWN -> super.onKeyDown(event.keyCode, event)
                KeyEvent.ACTION_UP -> super.onKeyUp(event.keyCode, event)
            }
        }
    }
    // Like the note view, keep hardware Enter's selection out of Gboard's
    // collapse-and-delete fallback: the table key only navigates.
    /** Ctrl+Enter: leave the table for the line after it (the controller owns both this field and the note). */
    var onLeaveTable: () -> Unit = {}

    override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER) {
            return when (event.action) {
                KeyEvent.ACTION_DOWN -> onKeyDown(keyCode, event)
                KeyEvent.ACTION_UP -> true
                else -> super.onKeyPreIme(keyCode, event)
            }
        }
        return super.onKeyPreIme(keyCode, event)
    }
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        // Hardware modifier down/up stay on the same native UI event queue.
        if (keyCode == KeyEvent.KEYCODE_SHIFT_LEFT || keyCode == KeyEvent.KEYCODE_SHIFT_RIGHT) {
            return super.onKeyDown(keyCode, event)
        }
        if (event.isCtrlPressed) {
            when (keyCode) {
                KeyEvent.KEYCODE_Z -> { if (event.isShiftPressed) editor.redo() else editor.undo(); return true }
                KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> { onLeaveTable(); return true }
                KeyEvent.KEYCODE_Y -> { editor.redo(); return true }
                KeyEvent.KEYCODE_A -> { onTextContextMenuItem(android.R.id.selectAll); return true }
                KeyEvent.KEYCODE_C -> { onTextContextMenuItem(android.R.id.copy); return true }
                KeyEvent.KEYCODE_X -> { onTextContextMenuItem(android.R.id.cut); return true }
                KeyEvent.KEYCODE_V -> { onTextContextMenuItem(android.R.id.paste); return true }
            }
            return true
        }
        val connection = engineInputConnection(editor, this, cell = true)
        editor.handler.post { connection.sendKeyEvent(event) }
        return true
    }
    fun showKeyboard() {
        requestFocus()
        context.getSystemService(InputMethodManager::class.java).showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
    }
    fun restartKeyboard() { context.getSystemService(InputMethodManager::class.java).restartInput(this) }
}

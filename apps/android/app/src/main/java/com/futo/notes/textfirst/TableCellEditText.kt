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
internal class TableCellEditText(context: Context, private val editor: EditorEngine, style: TextFirstStyle, private val marks: FindMarks = FindMarks()) :
    AppCompatEditText(context), EngineInputConnection.ViewSide {
    private var applying = false
    private var current: CellUpdate? = null
    /** This field and the painted note must describe the same session and applied frame. */
    fun placementTarget(note: TextFirstEditText): CellUpdate? = current?.takeIf {
        note.engine === editor && note.appliedSeq == it.viewSeq
    }
    fun applyGeometry(geometry: TableCellGeometry) {
        typeface = if (geometry.header) noteStyle.semibold else noteStyle.regular
        gravity = android.view.Gravity.TOP or android.view.Gravity.START
        textAlignment = when (geometry.alignment) {
            uniffi.futo_notes_ffi.EditorTableAlignment.RIGHT -> TEXT_ALIGNMENT_TEXT_END
            uniffi.futo_notes_ffi.EditorTableAlignment.CENTER -> TEXT_ALIGNMENT_CENTER
            else -> TEXT_ALIGNMENT_TEXT_START
        }
    }
    private val noteStyle = style
    init {
        setTextColor(style.textColor); textSize = style.textSizePx / resources.displayMetrics.scaledDensity
        typeface = style.regular
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
        imeOptions = EditorInfo.IME_ACTION_DONE or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        setPadding(style.dp(10f).toInt(), style.dp(10f).toInt(), style.dp(10f).toInt(), style.dp(10f).toInt())
        setBackgroundColor(style.codeBackground)
        includeFontPadding = false
        filters = arrayOf(InputFilter { _, _, _, dest, a, b -> if (applying) null else dest.subSequence(a, b) })
        importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO
    }
    override fun onDraw(canvas: android.graphics.Canvas) {
        val target = current
        val cellLayout = layout
        if (target != null && cellLayout != null) {
            val saved = canvas.save()
            canvas.translate(totalPaddingLeft.toFloat(), totalPaddingTop.toFloat())
            marks.drawCell(canvas, cellLayout, target.start, target.end, noteStyle)
            canvas.restoreToCount(saved)
        }
        super.onDraw(canvas)
    }
    override fun isSuggestionsEnabled() = false
    // A cell is note text, never a form field: no "Autofill" item over its selection menu.
    override fun getAutofillType() = AUTOFILL_TYPE_NONE
    fun apply(update: CellUpdate) {
        val sameWindow = current?.let { it.start == update.start && it.end == update.end && it.text == update.text } == true
        val sameText = text.toString() == update.text
        current = update
        applying = true
        try {
            if (!sameText) editableText.replace(0, editableText.length, update.text)
            val e = editableText
            e.getSpans(0, e.length, UnderlineSpan::class.java).forEach(e::removeSpan)
            if (update.composingStart >= 0 && update.composingEnd > update.composingStart) {
                e.setSpan(UnderlineSpan(), update.composingStart, update.composingEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE or Spanned.SPAN_COMPOSING)
            }
            val start = update.selectionStart.coerceIn(0, e.length)
            val end = update.selectionEnd.coerceIn(0, e.length)
            // An identical normalized echo must not reverse Shift's native anchor/focus.
            if (!sameWindow || !sameText || minOf(selectionStart, selectionEnd) != minOf(start, end) ||
                maxOf(selectionStart, selectionEnd) != maxOf(start, end)) Selection.setSelection(e, start, end)
        } finally { applying = false }
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
        // Android adds this flag for any multiline field. Cell text wraps, but
        // its explicit Done action still returns to the note; Rust owns Enter.
        outAttrs.imeOptions = outAttrs.imeOptions and EditorInfo.IME_FLAG_NO_ENTER_ACTION.inv()
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
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        // Hardware modifier down/up stay on the same native UI event queue.
        if (keyCode == KeyEvent.KEYCODE_SHIFT_LEFT || keyCode == KeyEvent.KEYCODE_SHIFT_RIGHT) {
            return super.onKeyDown(keyCode, event)
        }
        if (event.isCtrlPressed) {
            when (keyCode) {
                KeyEvent.KEYCODE_Z -> { if (event.isShiftPressed) editor.redo() else editor.undo(); return true }
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
    fun restartKeyboard() { context.getSystemService(InputMethodManager::class.java).restartInput(this) }
}

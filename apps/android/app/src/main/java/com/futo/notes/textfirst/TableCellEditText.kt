package com.futo.notes.textfirst

import android.content.ClipData
import android.content.ClipboardManager
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
    init {
        setTextColor(style.textColor); textSize = style.textSizePx / resources.displayMetrics.scaledDensity
        typeface = style.regular
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
        imeOptions = EditorInfo.IME_ACTION_DONE or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        setPadding(style.dp(12f).toInt(), style.dp(12f).toInt(), style.dp(12f).toInt(), style.dp(12f).toInt())
        filters = arrayOf(InputFilter { _, _, _, dest, a, b -> if (applying) null else dest.subSequence(a, b) })
    }
    override fun isSuggestionsEnabled() = false
    fun apply(update: CellUpdate) {
        current = update
        applying = true
        try {
            if (text.toString() != update.text) editableText.replace(0, editableText.length, update.text)
            val e = editableText
            e.getSpans(0, e.length, UnderlineSpan::class.java).forEach(e::removeSpan)
            if (update.composingStart >= 0 && update.composingEnd > update.composingStart) {
                e.setSpan(UnderlineSpan(), update.composingStart, update.composingEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE or Spanned.SPAN_COMPOSING)
            }
            Selection.setSelection(e, update.selectionStart.coerceIn(0, e.length), update.selectionEnd.coerceIn(0, e.length))
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
        outAttrs.initialSelStart = selectionStart; outAttrs.initialSelEnd = selectionEnd
        return EngineInputConnection(editor, this, cell = true)
    }
    override fun onTextContextMenuItem(id: Int): Boolean {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        when (id) {
            android.R.id.copy, android.R.id.cut -> editor.copy(id == android.R.id.cut) { clipboard.setPrimaryClip(ClipData.newPlainText(null, it)) }
            android.R.id.paste, android.R.id.pasteAsPlainText -> clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()?.let(editor::paste)
            android.R.id.selectAll -> editor.command { editor.cellRange?.let { editor.select(it.first, it.last, false) } }
            android.R.id.undo -> editor.undo()
            android.R.id.redo -> editor.redo()
            else -> return super.onTextContextMenuItem(id)
        }
        return true
    }
    override fun contextMenuAction(id: Int) { post { onTextContextMenuItem(id) } }
    override fun navigationKey(event: KeyEvent) { post { super.onKeyDown(event.keyCode, event) } }
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
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
        val connection = EngineInputConnection(editor, this, cell = true)
        editor.handler.post { connection.sendKeyEvent(event) }
        return true
    }
    fun restartKeyboard() { context.getSystemService(InputMethodManager::class.java).restartInput(this) }
}

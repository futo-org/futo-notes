package com.futo.notes.textfirst

import android.graphics.drawable.GradientDrawable
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.Selection
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewTreeObserver
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import kotlin.math.roundToInt

/**
 * A block's name or language field, open over its header (!300 cb 602-616, 966-987). Every
 * keystroke writes the fence through the engine; the field keeps what is typed while it is open,
 * even where the fence cannot hold it (a trailing space on a name). Enter, Down and Tab from the
 * language leave for the code; Up leaves for the line above; Tab from the name goes to the
 * language and Shift+Tab back. A press anywhere else closes it.
 */
internal class CodeHeaderField(private val note: TextFirstEditText) {
    enum class Kind { NAME, LANGUAGE }

    private class Editing(val codeStart: Int, val kind: Kind, var language: String, var name: String)

    private var editing: Editing? = null
    private var field: EditText? = null
    /** The open field's left edge, in layout coordinates. */
    private var fieldLeft = 0f
    private val follow = ViewTreeObserver.OnPreDrawListener { place(); true }

    /** [tapX], in layout coordinates, is where a tap landed: the field's caret goes there (cb 285-299). */
    fun open(target: CodeBlockTarget, kind: Kind, selectAll: Boolean, tapX: Float? = null) {
        close()
        val block = target.block ?: return
        val state = Editing(target.codeStart, kind, block.language.orEmpty(), block.name.orEmpty())
        editing = state
        note.codeChrome.openField = target.codeStart to kind
        // Entering a field ends the note's selection, so a selected block's paint goes (cb 285-299).
        if (note.selectionStart != note.selectionEnd) Selection.setSelection(note.editableText, note.selectionStart)
        val host = note.parent as? FrameLayout ?: return
        val field = buildField(state)
        this.field = field
        host.addView(field, FrameLayout.LayoutParams(1, 1))
        note.viewTreeObserver.addOnPreDrawListener(follow)
        place()
        field.requestFocus()
        when {
            selectAll -> field.selectAll()
            tapX != null -> field.post { field.setSelection(field.getOffsetForPosition(tapX - fieldLeft, field.height / 2f).coerceIn(0, field.length())) }
            else -> field.setSelection(field.length())
        }
        field.post { note.context.getSystemService(InputMethodManager::class.java).showSoftInput(field, 0) }
        note.invalidate()
    }

    fun close() {
        val open = field ?: return
        val hadFocus = open.hasFocus()
        forget()
        (open.parent as? FrameLayout)?.removeView(open)
        if (hadFocus) note.requestFocus()
    }

    private fun forget() {
        field = null
        editing = null
        note.codeChrome.openField = null
        note.viewTreeObserver.takeIf { it.isAlive }?.removeOnPreDrawListener(follow)
        note.invalidate()
    }

    private fun buildField(state: Editing): EditText {
        val look = note.style
        // Keys reach the field two ways: a hardware key before the keyboard sees it, and Gboard's
        // forwarded Enter, Tab and arrows through the input connection (the window never routes
        // those to a field it hosts beside the note).
        val field = object : EditText(note.context) {
            override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean =
                (event.action == KeyEvent.ACTION_DOWN && key(state, keyCode, event)) || super.onKeyPreIme(keyCode, event)

            override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
                val base = super.onCreateInputConnection(outAttrs) ?: return null
                return object : InputConnectionWrapper(base, true) {
                    override fun sendKeyEvent(event: KeyEvent): Boolean =
                        (event.action == KeyEvent.ACTION_DOWN && key(state, event.keyCode, event)) ||
                            (event.action == KeyEvent.ACTION_UP && isFieldKey(event.keyCode)) || super.sendKeyEvent(event)
                }
            }
        }
        field.typeface = look.mono
        field.setTextSize(TypedValue.COMPLEX_UNIT_PX, look.codeHeaderTextSize)
        field.setTextColor(look.textColor)
        field.highlightColor = look.selectionColor
        field.background = GradientDrawable().apply {
            cornerRadius = look.codeRadius
            setColor((look.textColor and 0x00ffffff) or 0x14000000)
        }
        val pad = look.codeChipPad.roundToInt()
        field.setPadding(pad, 0, pad, 0)
        field.gravity = Gravity.CENTER_VERTICAL
        field.isSingleLine = true
        field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        field.imeOptions = EditorInfo.IME_ACTION_DONE or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        if (state.kind == Kind.LANGUAGE) field.filters = arrayOf(languageFilter)
        field.setText(if (state.kind == Kind.NAME) state.name else state.language)
        field.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable) { write(state, s.toString()) }
        })
        field.setOnEditorActionListener { _, _, _ -> leaveToCode(state); true }
        return field
    }

    private fun write(state: Editing, text: String) {
        if (state.kind == Kind.NAME) state.name = text.trim() else state.language = text
        note.engine?.writeCodeBlockHeader(state.codeStart, state.language, state.name) {}
        place()
    }

    private fun key(state: Editing, keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER, KeyEvent.KEYCODE_DPAD_DOWN -> leaveToCode(state)
            KeyEvent.KEYCODE_DPAD_UP -> leaveUp(state)
            KeyEvent.KEYCODE_TAB -> when {
                state.kind == Kind.NAME && !event.isShiftPressed -> reopen(state, Kind.LANGUAGE)
                state.kind == Kind.LANGUAGE && event.isShiftPressed -> reopen(state, Kind.NAME)
                state.kind == Kind.LANGUAGE -> leaveToCode(state)
                else -> Unit
            }
            else -> return false
        }
        return true
    }

    private fun isFieldKey(keyCode: Int): Boolean = keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER ||
        keyCode == KeyEvent.KEYCODE_TAB || keyCode == KeyEvent.KEYCODE_DPAD_UP || keyCode == KeyEvent.KEYCODE_DPAD_DOWN

    private fun reopen(state: Editing, kind: Kind) {
        val action = if (kind == Kind.NAME) CodeBlockAction.NAME_FIELD else CodeBlockAction.LANGUAGE_LABEL
        val area = note.codeChrome.areaOf(state.codeStart, action) ?: return
        val block = CodeBlockFacts(state.codeStart, state.codeStart, state.language, state.name, 0)
        open(CodeBlockTarget(area, action, state.codeStart, block), kind, selectAll = false)
    }

    private fun leaveToCode(state: Editing) {
        close()
        Selection.setSelection(note.editableText, state.codeStart)
        note.showKeyboard()
    }

    /** Up leaves for the line above; a block that opens the note has none, so the field stays. */
    private fun leaveUp(state: Editing) {
        if (state.codeStart == 0) return
        close()
        Selection.setSelection(note.editableText, state.codeStart - 1)
        note.showKeyboard()
    }

    /** Over the field's part of the header, as wide as its text plus its collar. */
    private fun place() {
        val state = editing ?: return
        val open = field ?: return
        val action = if (state.kind == Kind.NAME) CodeBlockAction.NAME_FIELD else CodeBlockAction.LANGUAGE_LABEL
        val area = note.codeChrome.areaOf(state.codeStart, action) ?: return
        val look = note.style
        val inset = look.codeHeaderHeight * 0.12f
        val textWidth = open.paint.measureText(open.text.toString()) + look.codeChipPad * 2 + look.dp(2f)
        val width = maxOf(textWidth, look.codeChipPad * 4).coerceAtMost(note.width * 0.6f)
        // The language field takes the chip's place, its glyph included, anchored to the card's right corner (cb 300-302).
        val chipRight = (note.codeChrome.areaOf(state.codeStart, CodeBlockAction.COPY_CODE)?.right ?: area.right) - look.codeCorner + look.codeChipPad
        val left = if (state.kind == Kind.NAME) area.left + look.codeCorner - look.codeChipPad else chipRight - width
        fieldLeft = left
        // The note's parent lays out only the note (TextFirstTableCellHost), so the field is placed here.
        val x = (note.left + note.totalPaddingLeft - note.scrollX + left).roundToInt()
        val y = (note.top + note.totalPaddingTop - note.scrollY + area.top + inset).roundToInt()
        val w = width.roundToInt()
        val h = (area.height() - inset * 2).roundToInt()
        if (open.measuredWidth != w || open.measuredHeight != h || open.isLayoutRequested) {
            open.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
        }
        if (open.left != x || open.top != y || open.width != w || open.height != h || open.isLayoutRequested) open.layout(x, y, x + w, y + h)
    }

    private companion object {
        /** A language is one token: a space becomes a hyphen, and a leading one is dropped (!300 cb 371-373). */
        val languageFilter = InputFilter { source, start, end, _, dstart, _ ->
            val typed = source.subSequence(start, end).toString()
            if (' ' !in typed) return@InputFilter null
            val hyphenated = typed.replace(' ', '-')
            if (dstart == 0) hyphenated.trimStart('-') else hyphenated
        }
    }
}

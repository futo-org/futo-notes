package com.futo.notes.textfirst

import android.graphics.Paint
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.Selection
import android.text.Spanned
import android.text.TextPaint
import android.text.TextWatcher
import android.text.style.LineHeightSpan
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
    /** The note's height when the field last settled: the keyboard resizes the note over many frames. */
    private var settledHeight = -1
    private val settle = Runnable { editing?.let { state -> keepInView(state) } }
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
        // Placed and laid out above, so the caret goes straight to the tap: never a frame at the start (verifier run 1, item 7).
        when {
            selectAll -> field.selectAll()
            tapX != null -> field.setSelection(field.getOffsetForPosition(tapX - fieldLeft, field.height / 2f).coerceIn(0, field.length()))
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
        note.removeCallbacks(settle)
        settledHeight = -1
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
        // The drawn label's face, so the text does not change shape when the field opens or closes.
        field.typeface = if (state.kind == Kind.NAME) look.mono else look.regular
        field.setTextSize(TypedValue.COMPLEX_UNIT_PX, look.codeHeaderTextSize)
        // !300's fields keep the header's grey ink while they are edited.
        field.setTextColor(look.codeChromeInk)
        field.highlightColor = look.selectionColor
        val inset = (look.codeHeaderHeight * 0.12f).roundToInt()
        field.background = InsetDrawable(GradientDrawable().apply {
            cornerRadius = look.codeRadius
            setColor((look.textColor and 0x00ffffff) or 0x14000000)
        }, 0, inset, 0, inset)
        // The field spans the header row and puts its one line's baseline on the drawn label's (CodeBlockChrome.headerBaseline),
        // so the text does not move when it opens, as it is typed, or when it closes; its highlight, the line's box, is then centred too.
        field.includeFontPadding = false
        val pad = look.codeChipPad.roundToInt()
        val line = CentredLine(field.paint)
        val baseline = note.codeChrome.headerBaseline(0f, field.typeface).roundToInt()
        field.setPadding(pad, baseline + line.ascent, pad, 0)
        field.gravity = Gravity.TOP or Gravity.START
        field.isSingleLine = true
        field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        // !300's fields name their Enter key (enterkeyhint), which Gboard shows as the Go arrow (job12/ref-fields-light.png).
        field.imeOptions = EditorInfo.IME_ACTION_GO or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        if (state.kind == Kind.LANGUAGE) field.filters = arrayOf(languageFilter)
        field.setText(if (state.kind == Kind.NAME) state.name else state.language)
        field.text.setSpan(line, 0, field.text.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
        field.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable) { write(state, s.toString()) }
        })
        field.setOnEditorActionListener { _, _, _ -> leaveToCode(state); true }
        // The field's focus is the note's to whoever listens for it: the editor toolbar stays while it is open.
        field.setOnFocusChangeListener { _, _ -> note.onFocusChangeListener?.onFocusChange(note, note.hasFocus()) }
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
        if (note.height != settledHeight) {
            settledHeight = note.height
            note.removeCallbacks(settle)
            note.postDelayed(settle, SETTLE_MILLISECONDS)
        }
        val look = note.style
        val textWidth = open.paint.measureText(open.text.toString()) + look.codeChipPad * 2 + look.dp(2f)
        val width = maxOf(textWidth, look.codeChipPad * 4).coerceAtMost(note.width * 0.6f)
        // The language field takes the chip's place, its glyph included, anchored to the card's right corner (cb 300-302).
        val chipRight = (note.codeChrome.areaOf(state.codeStart, CodeBlockAction.COPY_CODE)?.right ?: area.right) - look.codeCorner + look.codeChipPad
        val left = if (state.kind == Kind.NAME) area.left + look.codeCorner - look.codeChipPad else chipRight - width
        fieldLeft = left
        // The note's parent lays out only the note (TextFirstTableCellHost), so the field is placed here.
        val x = (note.left + note.totalPaddingLeft - note.scrollX + left).roundToInt()
        val y = (note.top + note.totalPaddingTop - note.scrollY + area.top).roundToInt()
        val w = width.roundToInt()
        val h = area.height().roundToInt()
        if (open.measuredWidth != w || open.measuredHeight != h || open.isLayoutRequested) {
            open.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
        }
        if (open.left != x || open.top != y || open.width != w || open.height != h || open.isLayoutRequested) open.layout(x, y, x + w, y + h)
    }

    /**
     * A field the keyboard or the note's edge covers is scrolled just into view; a field already in
     * view is never moved (Mason, 2026-11-17: the note slid away under an open field). It runs once the
     * keyboard has finished resizing the note: measured mid-animation, it overshoots and settles back.
     */
    private fun keepInView(state: Editing) {
        val action = if (state.kind == Kind.NAME) CodeBlockAction.NAME_FIELD else CodeBlockAction.LANGUAGE_LABEL
        val area = note.codeChrome.areaOf(state.codeStart, action) ?: return
        val frame = Rect().also(note::getWindowVisibleDisplayFrame)
        val onScreen = IntArray(2).also(note::getLocationOnScreen)
        // The note runs on under the keyboard (the screen pads its own column, not the note), and the
        // keyboard toolbar sits on the keyboard: keep the field clear of both, with room for the toolbar.
        val keyboardTop = frame.bottom - onScreen[1] - note.style.codeHeaderHeight * 2
        val visibleBottom = minOf((note.height - note.totalPaddingBottom).toFloat(), keyboardTop)
        val top = note.totalPaddingTop - note.scrollY + area.top
        val bottom = note.totalPaddingTop - note.scrollY + area.bottom
        val shift = when {
            bottom > visibleBottom -> bottom - visibleBottom
            top < note.totalPaddingTop -> top - note.totalPaddingTop
            else -> return
        }
        note.scrollTo(note.scrollX, (note.scrollY + shift).roundToInt().coerceAtLeast(0))
    }

    private companion object {
        /** How long the note's height must hold still before an open field is brought into view. */
        const val SETTLE_MILLISECONDS = 120L

        /** A language is one token: a space becomes a hyphen, and a leading one is dropped (!300 cb 371-373). */
        val languageFilter = InputFilter { source, start, end, _, dstart, _ ->
            val typed = source.subSequence(start, end).toString()
            if (' ' !in typed) return@InputFilter null
            val hyphenated = typed.replace(' ', '-')
            if (dstart == 0) hyphenated.trimStart('-') else hyphenated
        }
    }
}

/**
 * The field's one line, as tall as the font's but centred on what the eye sees, from the capitals'
 * top to the descenders' bottom, so the selection highlight sits around the text instead of
 * reaching mostly above it (Mason, 2026-11-17: "magnetized to the top").
 */
private class CentredLine(paint: TextPaint) : LineHeightSpan {
    val ascent: Int
    private val descent: Int

    init {
        val metrics = paint.fontMetricsInt
        val capital = Rect().also { paint.getTextBounds("H", 0, 1, it) }
        val height = metrics.descent - metrics.ascent
        val centre = (capital.top + metrics.descent) / 2f
        ascent = (centre - height / 2f).roundToInt()
        descent = ascent + height
    }

    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        fm.ascent = ascent
        fm.top = ascent
        fm.descent = descent
        fm.bottom = descent
    }
}


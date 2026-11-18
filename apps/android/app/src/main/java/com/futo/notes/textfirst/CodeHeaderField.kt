package com.futo.notes.textfirst

import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.os.Build
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
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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

    /** [area] is the field's last drawn place: a header scrolled out of the drawn range has no target, yet must be revealed. */
    private class Editing(val codeStart: Int, val kind: Kind, var language: String, var name: String, var area: RectF? = null)

    private var editing: Editing? = null
    private var field: EditText? = null
    /** The note's height and the keyboard's when the field last settled: both move over many frames. */
    private var settledHeight = -1
    private var settledKeyboard = -1
    private val settle = Runnable { editing?.let { state -> keepInView(state) } }
    /** The open field's left edge, in layout coordinates. */
    private var fieldLeft = 0f
    /** An undo or redo was sent from the field: its text follows the block's once the change arrives. */
    private var followingHistory = false
    /** The field's text is being set from the block, not typed: it is not written back. */
    private var adopting = false
    private val follow = ViewTreeObserver.OnPreDrawListener { place(); true }

    /** The block (by where its code starts) and the field open on it, while one is. */
    val openField: Pair<Int, Kind>? get() = editing?.let { it.codeStart to it.kind }

    /** [tapX], in layout coordinates, is where a tap landed: the field's caret goes there (cb 285-299). */
    fun open(codeStart: Int, kind: Kind, language: String, name: String, selectAll: Boolean, tapX: Float? = null) {
        close()
        val host = note.parent as? FrameLayout ?: return
        val state = Editing(codeStart, kind, language, name)
        editing = state
        // Entering a field ends the note's selection, so a selected block's paint goes (cb 285-299).
        if (note.selectionStart != note.selectionEnd) Selection.setSelection(note.editableText, note.selectionStart)
        val field = buildField(state)
        this.field = field
        host.addView(field, FrameLayout.LayoutParams(1, 1))
        note.viewTreeObserver.addOnPreDrawListener(follow)
        place()
        field.requestFocus()
        // Placed and laid out above, so the caret goes straight to the tap: never a frame at the start.
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

    /**
     * After every change the engine applied: the field stays on its block only while that block's code still starts
     * where it did (its own header write moves nothing); an undo it sent shows the block's value.
     */
    fun followEngine() {
        val state = editing ?: return
        val open = field ?: return
        val e = note.editableText ?: return
        val head = e.getSpans(state.codeStart, state.codeStart, TfCodeBlock::class.java)
            .firstOrNull { it.line.first && e.getSpanStart(it) == state.codeStart }
        if (head == null) { close(); return }
        if (!followingHistory) return
        followingHistory = false
        val value = (if (state.kind == Kind.NAME) head.line.block.name else head.line.block.language).orEmpty()
        if (state.kind == Kind.NAME) state.name = value else state.language = value
        if (value == open.text.toString()) return
        adopting = true
        try {
            open.setText(value)
            open.text.setSpan(CentredLine(open.paint), 0, open.text.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
            open.setSelection(open.length())
        } finally { adopting = false }
    }

    private fun forget() {
        note.removeCallbacks(settle)
        settledHeight = -1
        settledKeyboard = -1
        field = null
        editing = null
        followingHistory = false
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
        // Both of !300's fields are mono.
        field.typeface = look.mono
        field.setTextSize(TypedValue.COMPLEX_UNIT_PX, look.codeHeaderTextSize)
        // !300's fields are inked as text while edited, with a thin caret in the same ink.
        field.setTextColor(look.textColor)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            field.setTextCursorDrawable(GradientDrawable().apply { setColor(look.textColor); setSize(look.dp(1f).roundToInt(), 0) })
        }
        field.highlightColor = look.selectionColor
        // The field spans the header row and puts its one line's baseline on the drawn label's (CodeBlockChrome.headerBaseline),
        // so the text does not move when it opens, as it is typed, or when it closes.
        field.includeFontPadding = false
        val pad = look.codeChipPad.roundToInt()
        val line = CentredLine(field.paint)
        val baseline = note.codeChrome.headerBaseline(0f, field.typeface).roundToInt()
        // !300's fill: 2 px from the card's top, 24 px tall (Mason's spacing). Set before the padding, which a background
        // replaces with its own.
        val chipTop = look.codeFieldInset.roundToInt()
        field.background = InsetDrawable(GradientDrawable().apply {
            cornerRadius = look.codeRadius
            setColor((look.textColor and 0x00ffffff) or 0x14000000)
        }, 0, chipTop, 0, (look.codeHeaderHeight - chipTop - look.codeFieldHeight).roundToInt())
        field.setPadding(pad, baseline + line.ascent, pad, 0)
        field.gravity = Gravity.TOP or Gravity.START
        field.isSingleLine = true
        field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        // !300's fields name their Enter key (enterkeyhint), which Gboard shows as the Go arrow.
        field.imeOptions = EditorInfo.IME_ACTION_GO or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        if (state.kind == Kind.LANGUAGE) field.filters = arrayOf(languageFilter)
        val labels = note.codeChrome.labels
        field.hint = if (state.kind == Kind.NAME) labels.namePlaceholder else labels.languagePlaceholder
        field.setHintTextColor((look.codeChromeInk and 0x00ffffff) or (CodeBlockChrome.GHOST_ALPHA shl 24))
        field.setText(if (state.kind == Kind.NAME) state.name else state.language)
        field.text.setSpan(line, 0, field.text.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
        field.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable) { if (!adopting) write(state, s.toString()) }
        })
        // The field is part of the note: focus going anywhere else (the title, a cell) closes it, and the note then
        // takes the blur it skipped when the field opened (TextFirstController's focus listener).
        field.setOnFocusChangeListener { view, hasFocus ->
            if (hasFocus || this.field !== view) return@setOnFocusChangeListener
            note.post {
                if (this.field !== view || view.hasFocus() || note.hasFocus()) return@post
                close()
                note.onFocusChangeListener?.onFocusChange(note, false)
            }
        }
        field.setOnEditorActionListener { _, _, _ -> leaveToCode(state); true }
        return field
    }

    private fun write(state: Editing, text: String) {
        if (state.kind == Kind.NAME) state.name = text.trim() else state.language = text
        note.engine?.writeCodeBlockHeader(state.codeStart, state.language, state.name)
        place()
    }

    private fun key(state: Editing, keyCode: Int, event: KeyEvent): Boolean {
        // Undo and redo are the note's, one keystroke at a time, as the toolbar's are.
        if (event.isCtrlPressed && (keyCode == KeyEvent.KEYCODE_Z || keyCode == KeyEvent.KEYCODE_Y)) {
            val engine = note.engine ?: return false
            if (keyCode == KeyEvent.KEYCODE_Y || event.isShiftPressed) engine.redo() else engine.undo()
            followingHistory = true
            return true
        }
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
        if (note.codeChrome.areaOf(state.codeStart, action) == null) return
        open(state.codeStart, kind, state.language, state.name, selectAll = false)
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
        val keyboard = ViewCompat.getRootWindowInsets(note)?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
        // The insets give the keyboard's final height at once, so a keyboard change reveals at once, while it rises, as
        // !300 does; the note's own resize follows over many frames and settles first.
        // The keyboard went away with the field open: the field closes to its label, as !300's does.
        if (settledKeyboard > 0 && keyboard == 0) { note.post { close() }; return }
        val keyboardMoved = settledKeyboard != -1 && keyboard != settledKeyboard
        if (keyboardMoved || note.height != settledHeight || settledKeyboard == -1) {
            settledHeight = note.height
            settledKeyboard = keyboard
            note.removeCallbacks(settle)
            if (keyboardMoved) note.post(settle) else note.postDelayed(settle, SETTLE_MILLISECONDS)
        }
        val area = fieldArea(state) ?: return
        val look = note.style
        // Its text, or the placeholder while empty, and a constant collar: no minimum, no pocket of space (cb 66-73).
        val shown = open.text.ifEmpty { open.hint ?: "" }.toString()
        // The collar, and the caret's own width so the text never scrolls under it.
        val textWidth = open.paint.measureText(shown) + look.codeChipPad * 2 + look.dp(1f)
        // !300's name field is at most 45% of the header, its language chip 30%.
        val header = (note.layout?.width ?: note.width) + look.codeCardOutset * 2
        val widest = header * if (state.kind == Kind.NAME) CodeBlockChrome.NAME_SHARE else CodeBlockChrome.LANGUAGE_SHARE
        val width = textWidth.coerceAtMost(widest)
        // The language field takes the chip's place, its glyph included, anchored to the card's right corner (cb 300-302).
        val chipRight = (note.codeChrome.areaOf(state.codeStart, CodeBlockAction.COPY_CODE)?.right ?: area.right) - look.codeCorner + look.codeChipPad
        val left = if (state.kind == Kind.NAME) area.left + look.codeFieldInset else chipRight - width
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
    private fun fieldArea(state: Editing): RectF? {
        val action = if (state.kind == Kind.NAME) CodeBlockAction.NAME_FIELD else CodeBlockAction.LANGUAGE_LABEL
        note.codeChrome.areaOf(state.codeStart, action)?.let { drawn -> state.area = RectF(drawn) }
        return state.area
    }

    private fun keepInView(state: Editing) {
        val area = fieldArea(state) ?: return
        // The keyboard resizes the note (the screen's imePadding) a few frames after it reports its height: measure
        // against the keyboard's own top, so the first reveal lands where the note will end and the resize moves nothing.
        // Only a field the keyboard covers moves the note, as on !300; when leaving
        // brings the toolbar back over the caret's line, the caret's own reveal moves it then (ruling, 2026-11-17).
        val keyboard = ViewCompat.getRootWindowInsets(note)?.takeIf { it.isVisible(WindowInsetsCompat.Type.ime()) }
            ?.getInsets(WindowInsetsCompat.Type.ime())?.bottom
        val inWindow = IntArray(2).also(note::getLocationInWindow)
        val keyboardTop = keyboard?.let { note.rootView.height - it - inWindow[1] } ?: note.height
        val visibleBottom = minOf(note.height, keyboardTop) - note.totalPaddingBottom
        val top = note.totalPaddingTop - note.scrollY + area.top
        val bottom = note.totalPaddingTop - note.scrollY + area.bottom
        val shift = when {
            bottom > visibleBottom -> bottom - visibleBottom
            top < note.totalPaddingTop -> top - note.totalPaddingTop
            else -> return
        }
        // Never past the note's end: the next restyle would pull it back while the reader types.
        note.scrollTo(note.scrollX, (note.scrollY + shift).roundToInt().coerceIn(0, note.maxScrollY()))
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

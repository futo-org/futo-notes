package com.futo.notes.textfirst

import android.annotation.SuppressLint
import android.content.Context
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.Selection
import android.text.Spannable
import android.text.Spanned
import android.text.style.UnderlineSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import androidx.appcompat.widget.AppCompatEditText
import uniffi.futo_notes_ffi.EditorParagraphKey

/**
 * The platform text view. It holds display text only and never edits it on
 * its own: every change arrives as a [UiUpdate] from the [EditorEngine], and
 * an input filter refuses anything else (TextView's own key listener, the
 * spell-check popup, autofill) so the Editable cannot drift from the engine.
 */
@SuppressLint("ViewConstructor")
internal class TextFirstEditText(
    context: Context,
    internal val style: TextFirstStyle,
    internal val images: ImageLoader,
) : AppCompatEditText(context), EngineInputConnection.ViewSide {
    var engine: EditorEngine? = null
    var onOpenWikilink: ((String) -> Unit)? = null
    var onOpenUrl: ((String) -> Unit)? = null
    private val wikilinkTouch = WikilinkTouch(this) { onOpenWikilink?.invoke(it) }
    private val imageTouch = ImageTouch(this)
    @Volatile override var selectedImage: Pair<Int, Int>? = null
    private val linkTouch = ExternalLinkTouch(this, { onOpenUrl?.invoke(it) }, ::nativeTouch)
    private val lineTouch = LineSelectTouch(this)
    /** The first draw after a keyed update, with where that key's time went. */
    var onFrameDrawn: ((KeyTimings) -> Unit)? = null

    internal var applying = false
    private var appliedSeq = 0
    private var pendingTimings: KeyTimings? = null
    private var checkboxDown = -1
    var onTableCell: ((Int, Int, Int) -> Unit)? = null
    /** Paste and keyboard content; its [TextFirstClipboard.onImageContent] owner saves images. */
    val clipboard = TextFirstClipboard(context) { engine }
    private val tableTouch = TableGridTouch(this, { cell -> onTableCell?.invoke(cell.start, cell.end, appliedSeq) }, ::invalidateTableScroll)
    internal val marks = FindMarks()
    internal val scroll = NoteScroll(this)
    internal val spans = TfSpanFactory(style, marks, { contentWidth() }) { span ->
        wikilinkContentWidth(this, span, contentWidth())
    }
    /** The composing underline this view set; the only SPAN_COMPOSING span it owns. */
    private var composing: Any? = null

    init {
        background = null
        setTextColor(style.textColor)
        setTextSize(TypedValue.COMPLEX_UNIT_PX, style.textSizePx)
        typeface = style.regular
        // CSS line-height 1.55 is 1.55 × the font size; Android's multiplier
        // would scale Barlow's taller full height instead.
        lineHeight = (style.textSizePx * 1.55f).toInt()
        gravity = Gravity.TOP or Gravity.START
        val side = style.dp(18f).toInt()
        // TextView clips drawing to its padding, so no tall bottom padding here.
        setPadding(side, style.dp(14f).toInt(), side, style.dp(24f).toInt())
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
            InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
        imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_ENTER_ACTION
        setHorizontallyScrolling(false)
        isVerticalScrollBarEnabled = true
        // Autofill and content capture copy the whole text after every change.
        importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        if (android.os.Build.VERSION.SDK_INT >= 30) importantForContentCapture = IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS
        highlightColor = (style.linkColor and 0x00ffffff) or 0x40000000
        filters = arrayOf(InputFilter { source, _, _, dest, dstart, dend ->
            if (applying) null else dest.subSequence(dstart, dend)
        })
        setEditableFactory(object : Editable.Factory() {
            // apply() builds its text already chunked; copying it would set every span again.
            override fun newEditable(source: CharSequence): Editable =
                source as? ChunkedEditable ?: ChunkedEditable.from(source)
        })
    }

    // TextView's spell checker would scan and underline on every change and
    // offer a popup that edits the Editable directly. The keyboard's own
    // suggestions are unaffected: inputType still asks for them.
    override fun isSuggestionsEnabled(): Boolean = false

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val fallback = super.onCreateInputConnection(outAttrs)
        val engine = engine ?: return fallback
        val packed = engine.publishedSelection
        outAttrs.initialSelStart = (packed ushr 32).toInt()
        outAttrs.initialSelEnd = (packed and 0xffffffffL).toInt()
        outAttrs.imeOptions = outAttrs.imeOptions or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_ENTER_ACTION
        androidx.core.view.inputmethod.EditorInfoCompat.setContentMimeTypes(outAttrs, arrayOf("image/*"))
        return EngineInputConnection(engine, this)
    }

    override fun onCheckIsTextEditor(): Boolean = true

    // ---- engine → view ----

    fun apply(update: UiUpdate) {
        contentComplete = update.complete
        if (update.append) { applyAppend(update); scheduleRestore(); return }
        val applyStart = android.os.SystemClock.elapsedRealtimeNanos()
        var editsEnd = applyStart
        applying = true
        try {
            val reset = update.reset
            if (reset != null) {
                // Chunk first, then style: one whole-note SpannableStringBuilder
                // re-sorts its entire span table on every setSpan (quadratic open).
                val built = ChunkedEditable.from(reset + END_SENTINEL)
                for (window in update.windows) addSpans(built, window.specs)
                setText(built, BufferType.EDITABLE)
            } else {
                val e = editableText
                val t0 = System.nanoTime()
                beginBatchEdit()
                var t1 = t0
                try {
                    for (edit in update.edits) e.replace(edit.start, edit.end, edit.text)
                    t1 = System.nanoTime()
                    editsEnd = android.os.SystemClock.elapsedRealtimeNanos()
                    for (window in update.windows) restyle(e, window)
                } finally {
                    endBatchEdit()
                }
                if (PROFILE) {
                    val t2 = System.nanoTime()
                    android.util.Log.i("TextFirstApply", "replace=${(t1 - t0) / 1000}us restyle+batch=${(t2 - t1) / 1000}us windows=${update.windows.map { it.end - it.start }}")
                }
            }
            reveal.edited()
            val e = editableText
            // Not BaseInputConnection.removeComposingSpans: it lists every span in the note.
            composing?.let(e::removeSpan)
            composing = null
            if (update.composingStart >= 0 && update.composingEnd > update.composingStart) {
                composing = ComposingUnderline().also {
                    e.setSpan(it, update.composingStart, update.composingEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE or Spanned.SPAN_COMPOSING)
                }
            }
            val length = (e.length - 1).coerceAtLeast(0)
            Selection.setSelection(e, update.selStart.coerceIn(0, length), update.selEnd.coerceIn(0, length))
            appliedSeq = update.seq
            if (update.inputUptimeNanos != 0L && update.reset == null) {
                pendingTimings = KeyTimings(
                    input = update.inputUptimeNanos,
                    posted = update.postedNanos,
                    engine = update.engineNanos,
                    applyStart = applyStart,
                    editsEnd = editsEnd,
                    applyEnd = android.os.SystemClock.elapsedRealtimeNanos(),
                )
            }
        } finally {
            applying = false
        }
        if (update.reset != null) { requestImageLoads(); scheduleRestore() }
    }

    // ---- scroll position ----

    override fun onFocusChanged(focused: Boolean, direction: Int, previouslyFocusedRect: android.graphics.Rect?) {
        // Runs from TextView's constructor too, before this class's fields exist.
        @Suppress("SENSELESS_COMPARISON") if (reveal != null) reveal.again()
        super.onFocusChanged(focused, direction, previouslyFocusedRect)
    }

    /** Where the note was last left, until the view has scrolled there (or the user took over). */
    internal var restoring: ScrollAnchor? = null
    /** Whether the text is the whole note: while it is not, a position past its end may yet arrive. */
    internal var contentComplete = true
    internal var restoreQueued = false
    /**
     * The line the view was just put back on. Images above it land after the
     * open and change their lines' heights, which would carry it away: until
     * the reader touches the note (or a few seconds pass) it is held in place.
     */
    internal var pinned: ScrollAnchor? = null
    internal val unpin = Runnable { pinned = null }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        val anchor = pinned ?: return
        val y = anchorY(anchor) ?: return
        if (y != scrollY) scrollTo(scrollX, y)
    }

    private class ComposingUnderline : UnderlineSpan()

    /**
     * TextView clips its text to the padding box while scrolled, so the bottom
     * padding (breathing room under the last line) hid every line scrolled into
     * it behind a blank band. Only the clip reads this during a draw: scrolling
     * and caret-follow still keep the padding. The top padding cannot do the same
     * (the TextView offsets the text by it too): see drawTopPaddingBand.
     */
    private var drawing = false
    override fun getExtendedPaddingBottom(): Int = if (drawing) 0 else super.getExtendedPaddingBottom()

    internal val reveal = CaretReveal()

    override fun bringPointIntoView(offset: Int): Boolean =
        reveal.at(offset, ready = layout != null && height > 0) { super.bringPointIntoView(offset) }

    override fun isLayoutRequested(): Boolean = !reveal.ignoringLayout && super.isLayoutRequested()

    override fun onDraw(canvas: android.graphics.Canvas) {
        val timings = pendingTimings
        if (timings != null) timings.drawStart = android.os.SystemClock.elapsedRealtimeNanos()
        // Under the caret, which the TextView draws before the layout's own drawing.
        drawCodeBackgrounds(canvas)
        drawFindMarks(canvas)
        val e = editableText as? ChunkedEditable
        e?.drawWindow = visibleChars()
        drawing = true
        try { super.onDraw(canvas); drawTopPaddingBand(canvas) } finally { drawing = false; e?.drawWindow = null }
        if (timings != null) {
            timings.drawEnd = android.os.SystemClock.elapsedRealtimeNanos()
            pendingTimings = null
            onFrameDrawn?.invoke(timings)
        }
    }


    internal fun contentWidth(): Int = maxOf(1, width - totalPaddingLeft - totalPaddingRight - style.dp(4f).toInt())

    // Images and dividers size to the content width; a new width re-measures
    // their lines (one measured while the view was not laid out yet would
    // otherwise keep a stale height).
    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (h < oldh && caretWasInView(oldh)) { reveal.again(); bringPointIntoView(selectionEnd) }
        if (w == oldw) return
        val e = editableText ?: return
        applying = true
        try {
            for (atom in e.getSpans(0, e.length, TfAtom::class.java)) {
                if (atom !is TfImage && atom !is TfDivider && atom !is TfWikilink) continue
                e.setSpan(atom, e.getSpanStart(atom), e.getSpanEnd(atom), e.getSpanFlags(atom))
            }
        } finally {
            applying = false
        }
        requestImageLoads()
    }

    // ---- view → engine ----

    override fun onSelectionChanged(selStart: Int, selEnd: Int) {
        super.onSelectionChanged(selStart, selEnd)
        selectedImage = selectedImage?.takeIf { it.first == selStart && it.second == selEnd }
        if (applying) return
        val e = editableText ?: return
        // The end sentinel is not a caret position (an empty Editable has none yet).
        val last = (e.length - 1).coerceAtLeast(0)
        val (a, b) = clampOutOfAtoms(e, selStart.coerceAtMost(last), selEnd.coerceAtMost(last))
        if (a != selStart || b != selEnd) {
            applying = true
            try { Selection.setSelection(e, a, b) } finally { applying = false }
        }
        engine?.viewSelection(appliedSeq, a, b)
    }

    /** Atoms have caret stops only at their two ends (images.md). */
    private fun clampOutOfAtoms(e: Editable, start: Int, end: Int): Pair<Int, Int> {
        fun clamp(p: Int): Int {
            for (atom in e.getSpans(p, p, TfAtom::class.java)) {
                val s = e.getSpanStart(atom)
                val en = e.getSpanEnd(atom)
                if (p in (s + 1) until en) return if (p - s <= en - p) s else en
            }
            return p
        }
        return clamp(start) to clamp(end)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) { restoring = null; stopPinning(); scroll.down(event) } else scroll.track(event)
        if (!scroll.stoppingTouch && tableTouch.onTouch(event)) return true
        if (scroll.own(event) { super.onTouchEvent(it) }) return true
        if (onOpenUrl != null && linkTouch.onTouch(event)) return true
        if (wikilinkTouch.onTouch(event)) return true
        imageTouch.onTouch(event)
        // After the links, so a third quick tap on a link still opens it.
        if (lineTouch.onTouch(event)) return true
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                checkboxDown = checkboxAt(this, style, event.x, event.y)
                if (checkboxDown >= 0) return true
            }
            MotionEvent.ACTION_UP -> if (checkboxDown >= 0) {
                val hit = checkboxAt(this, style, event.x, event.y)
                if (hit == checkboxDown) engine?.toggleTaskAt(hit)
                checkboxDown = -1
                return true
            }
            MotionEvent.ACTION_MOVE -> if (checkboxDown >= 0) return true
            MotionEvent.ACTION_CANCEL -> if (checkboxDown >= 0) { checkboxDown = -1; return true }
        }
        return super.onTouchEvent(event).also { wikilinkTouch.settleCaret(); imageTouch.settleSelection() }
    }

    private fun nativeTouch(event: MotionEvent) { super.onTouchEvent(event) }

    override fun computeScroll() {
        super.computeScroll()
        scroll.step()
    }

    /** TextView caches drawing separately: changing span data also invalidates its text display list. */
    private fun invalidateTableScroll(scroll: TableScroll) {
        redrawTableRows { it.scroll === scroll }
        invalidate()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val engine = engine ?: return super.onKeyDown(keyCode, event)
        if (event.isCtrlPressed) {
            when (keyCode) {
                KeyEvent.KEYCODE_Z -> { if (event.isShiftPressed) engine.redo() else engine.undo(); return true }
                KeyEvent.KEYCODE_Y -> { engine.redo(); return true }
                KeyEvent.KEYCODE_B -> { engine.toggleFormat(uniffi.futo_notes_ffi.EditorInlineFormat.BOLD); return true }
                KeyEvent.KEYCODE_I -> { engine.toggleFormat(uniffi.futo_notes_ffi.EditorInlineFormat.ITALIC); return true }
                KeyEvent.KEYCODE_A -> { engine.selectAll(); return true }
                KeyEvent.KEYCODE_C -> { onTextContextMenuItem(android.R.id.copy); return true }
                KeyEvent.KEYCODE_X -> { onTextContextMenuItem(android.R.id.cut); return true }
                KeyEvent.KEYCODE_V -> { onTextContextMenuItem(android.R.id.paste); return true }
            }
        }
        val paragraphKey = when (keyCode) {
            KeyEvent.KEYCODE_DEL -> EditorParagraphKey.BACKSPACE
            KeyEvent.KEYCODE_FORWARD_DEL -> EditorParagraphKey.DELETE
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER ->
                if (event.isShiftPressed) EditorParagraphKey.SHIFT_ENTER else EditorParagraphKey.ENTER
            KeyEvent.KEYCODE_TAB -> if (event.isShiftPressed) EditorParagraphKey.SHIFT_TAB else EditorParagraphKey.TAB
            else -> null
        }
        if (paragraphKey != null) {
            engine.handler.post { engine.key(paragraphKey) }
            return true
        }
        val char = event.unicodeChar
        if (char != 0 && !event.isCtrlPressed && !event.isAltPressed) {
            val typed = String(Character.toChars(char))
            engine.handler.post { engine.imeCommit(typed) }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onTextContextMenuItem(id: Int): Boolean {
        if (engine == null) return false
        return clipboard.handle(id) || super.onTextContextMenuItem(id)
    }

    // ---- EngineInputConnection.ViewSide (editor thread → UI) ----

    override fun contextMenuAction(id: Int) {
        post { onTextContextMenuItem(id) }
    }

    override fun imageContent(info: android.view.inputmethod.InputContentInfo, flags: Int) =
        clipboard.commitContent(info, flags) { post(it) }

    override fun navigationKey(event: KeyEvent) {
        post {
            applying = false
            super.onKeyDown(event.keyCode, event)
        }
    }

    fun showKeyboard() {
        requestFocus()
        context.getSystemService(InputMethodManager::class.java).showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
    }

    fun hideKeyboard() {
        context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(windowToken, 0)
        clearFocus()
    }

    fun restartKeyboard() {
        context.getSystemService(InputMethodManager::class.java).restartInput(this)
    }

    companion object {
        /**
         * One zero-width character after the display text, never part of the
         * engine's text, the keyboard's copy or the caret's range. It keeps
         * the last line non-empty: Android lays out no paragraph spans (list
         * markers, quote bars) for an empty last line.
         */
        const val END_SENTINEL = "\u200B"

        /** How long a restored position is held against images loading above it. */
        internal const val PIN_MS = 4_000L

        /** Debug: log per-update apply timings under `TextFirstApply`. */
        var PROFILE = com.futo.notes.BuildConfig.DEBUG
    }
}

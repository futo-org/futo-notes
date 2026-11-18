package com.futo.notes.textfirst

import android.annotation.SuppressLint
import android.content.Context
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.Selection
import android.text.Spannable
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.appcompat.widget.AppCompatEditText

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
        set(value) {
            field = value
            if (renderHold.held) value?.holdRender(true)
        }
    internal val imePublisher = NativeImePublisher(this)
    var onOpenWikilink: ((WikilinkDestination) -> Unit)? = null
    var onLinkShortcut: (() -> Unit)? = null
    var onOpenUrl: ((String) -> Boolean)? = null
    private val wikilinkTouch = WikilinkTouch(this) { onOpenWikilink?.invoke(it) }
    private val imageTouch = ImageTouch(this)
    @Volatile override var renderedSelection: Long = Long.MIN_VALUE
        private set
    @Volatile override var selectedObject: Pair<Int, Int>? = null
    private val linkTouch = ExternalLinkTouch(this, { onOpenUrl?.invoke(it) ?: false }, ::nativeTouch)
    private val lineTouch = LineSelectTouch(this)
    internal val codeTouch = CodeBlockTouch(this)
    private val lineBelowHandle = CodeLineBelowHandle(this)
    /** A code block selected as one object: its card shows the selection, so the text highlight is hidden. */
    internal var selectedCodeBlock: Pair<Int, Int>? = null
        set(value) {
            if (field == value) return
            field = value
            refreshCodeInput()
            // A selected empty block is a collapsed range, but it is the object: no caret or handle in it, as on !300.
            isCursorVisible = value == null || value.first != value.second
            // Undo selects a block after its edits painted the same range as a band; the card alone shows it (12.5).
            if (value != null) codeSelectionTracker.painted = null
            refreshCodeHighlight()
            invalidate()
        }
    /** The first draw after a keyed update, with where that key's time went. */
    var onFrameDrawn: ((KeyTimings) -> Unit)? = null
    /** Optional benchmark observer for every apply, including progressive append work. */
    internal var onRenderFrame: ((Long) -> Unit)? = null
    internal var onApplyMeasured: ((KeyTimings, UiUpdate) -> Unit)? = null

    internal var applying = false
    /** True while the view moves its own selection (endSelectionOnBlur): not a placement by the user. */
    internal var movingSelectionItself = false
    /** True while the view takes the engine's selection: already resolved, so it is painted as it is. */
    internal var settlingFromEngine = false
    internal var appliedSeq = 0
    internal var pendingTimings: KeyTimings? = null
    private var checkboxDown = -1
    var onTableCell: ((Int, Int, Int) -> Unit)? = null
    /** The cell host settles against Android's final layout/caret reveal before drawing. */
    internal var onViewportReady: (() -> Unit)? = null
    /** Paste and keyboard content; its [TextFirstClipboard.onImageContent] owner saves images. */
    val clipboard = TextFirstClipboard(context) { engine }
    private val tableTouch = TableGridTouch(this, { cell -> onTableCell?.invoke(cell.start, cell.end, appliedSeq) }, ::invalidateTableScroll)
    internal val marks = FindMarks()
    internal val scroll = NoteScroll(this)
    internal val spans = TfSpanFactory(style, marks, { contentWidth() }) { span ->
        wikilinkContentWidth(this, span, contentWidth())
    }
    /** The composing underline this view set; the only SPAN_COMPOSING span it owns. */
    internal var composing: Any? = null
    private var codeInput = false
    private var codeCaret = false
    /** The view cut itself to a prefix for a new width; engine updates wait for the engine's reset (TextFirstEditTextWidth.kt). */
    internal var awaitingRelayout = false
    internal val renderHold = RenderHold(this)

    init {
        background = null
        setTextColor(style.textColor)
        setTextSize(TypedValue.COMPLEX_UNIT_PX, style.textSizePx)
        typeface = style.regular
        // CSS line-height 1.55 is 1.55 × the font size; Android's multiplier
        // would scale Barlow's taller full height instead.
        lineHeight = style.bodyLineHeight
        // A fallback font's taller metrics (Arabic, Hebrew) would grow its row past
        // that height; CSS keeps line-height fixed whatever font draws the glyphs.
        isFallbackLineSpacing = false
        gravity = Gravity.TOP or Gravity.START
        val side = style.dp(NOTE_TEXT_INSET_DP).toInt()
        // TextView clips drawing to its padding, so no tall bottom padding here.
        setPadding(side, style.dp(14f).toInt(), side, style.dp(24f).toInt())
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
            InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
        imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_ENTER_ACTION
        setHorizontallyScrolling(false)
        configureSelectionClassifier()
        customSelectionActionModeCallback = renderHold.MenuWatch()
        customInsertionActionModeCallback = renderHold.MenuWatch()
        textLocales = android.os.LocaleList.getDefault() // explicit: see onConfigurationChanged
        isVerticalScrollBarEnabled = true
        // Autofill and content capture copy the whole text after every change.
        importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        if (android.os.Build.VERSION.SDK_INT >= 30) importantForContentCapture = IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS
        highlightColor = style.selectionColor
        fitCaretToItsText()
        tintCaretAndSelectionHandles(style.linkColor)
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

    // Not important for autofill is not enough: augmented autofill still offers an
    // "Autofill" item in the selection menu, over Select all. A note is never a form field.
    override fun getAutofillType(): Int = AUTOFILL_TYPE_NONE

    // Never call super: its Editor would publish the clipped renderer's coordinates to the IME.
    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? = createEngineInputConnection(outAttrs, codeInput)

    override fun onCheckIsTextEditor(): Boolean = true

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        if (MeasureSpec.getMode(widthMeasureSpec) != MeasureSpec.UNSPECIFIED) {
            beforeNewWidth(MeasureSpec.getSize(widthMeasureSpec) - compoundPaddingLeft - compoundPaddingRight)
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    // TextView drops its layout on EVERY configuration change (a rotation, dark
    // mode, a keyboard plugged in) to pick up the default locale, unless its
    // locales were set explicitly; the next measure then lays out the whole note
    // again even at the same width. They are set explicitly (to the same default
    // TextView would use), and a real locale change is followed from a bounded
    // prefix (TextFirstEditTextWidth.kt).
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        val locales = android.os.LocaleList.getDefault()
        if (locales != textLocales) {
            boundForRelayout()
            textLocales = locales
        }
        super.onConfigurationChanged(newConfig)
    }

    // ---- background rendering waits for touch and the text menu (TextFirstRenderHold.kt) ----

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        renderHold.touchStarting(event)
        try { return super.dispatchTouchEvent(event) } finally { renderHold.touchEnded(event) }
    }

    override fun performLongClick(): Boolean {
        renderHold.longPressed()
        return super.performLongClick()
    }

    internal fun setCodeInput(code: Boolean) {
        codeCaret = code
        refreshCodeInput()
    }

    /** Code input while the caret is in code; a block selected as one object is replaced by prose, so not then. */
    private fun refreshCodeInput() {
        val code = codeCaret && selectedCodeBlock == null
        if (codeInput == code) return
        codeInput = code
        if (isFocused) restartKeyboard()
    }

    // ---- engine → view ----

    fun apply(update: UiUpdate) = applyEngineUpdate(update)

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
    internal val codeCardPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    internal val codeChrome by lazy { CodeBlockChrome(style) }
    internal val codeSelectionTracker = CodeSelectionTracker()

    override fun bringPointIntoView(offset: Int): Boolean = revealCaret(offset) { super.bringPointIntoView(offset) }

    override fun isLayoutRequested(): Boolean = !reveal.ignoringLayout && super.isLayoutRequested()

    override fun onPreDraw(): Boolean = super.onPreDraw().also { onViewportReady?.invoke() }

    override fun onDraw(canvas: android.graphics.Canvas) {
        val timings = pendingTimings
        if (timings != null) timings.drawStart = android.os.SystemClock.elapsedRealtimeNanos()
        // Under the caret, which the TextView draws before the layout's own drawing.
        drawCodeBlocks(canvas)
        lineBelowHandle.afterDraw()
        drawCodeSelection(canvas)
        drawListSelection(canvas)
        drawFindMarks(canvas)
        val e = editableText as? ChunkedEditable
        e?.drawWindow = visibleChars()
        drawing = true
        try { super.onDraw(canvas); drawSelectedImageTint(canvas); drawTopPaddingBand(canvas); drawScrollEdge(canvas) } finally { drawing = false; e?.drawWindow = null }
        if (timings != null) {
            timings.drawEnd = android.os.SystemClock.elapsedRealtimeNanos()
            pendingTimings = null
            onFrameDrawn?.invoke(timings)
        }
        onRenderFrame?.invoke(android.os.SystemClock.elapsedRealtimeNanos())
    }


    internal fun contentWidth(): Int = maxOf(1, width - totalPaddingLeft - totalPaddingRight - style.dp(4f).toInt())

    // Images and dividers size to the content width; a new width re-measures
    // their lines (one measured while the view was not laid out yet would
    // otherwise keep a stale height).
    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (h > oldh) clampScrollToNote()
        if (h < oldh && isFocused && caretWasInView(oldh)) { reveal.again(); bringPointIntoView(selectionEnd) }
        if (w != oldw) refreshWidthDependentSpans()
    }

    // ---- view → engine ----

    override fun onSelectionChanged(selStart: Int, selEnd: Int) {
        super.onSelectionChanged(selStart, selEnd)
        if (coversImage(selStart, selEnd) || coversImage((renderedSelection shr 32).toInt(), renderedSelection.toInt())) invalidate()
        renderedSelection = (selStart.toLong() shl 32) or (selEnd.toLong() and 0xffffffffL)
        selectedObject = selectedObject?.takeIf { it.first == selStart && it.second == selEnd }
        selectedCodeBlock = selectedCodeBlock?.takeIf { it.first == selStart && it.second == selEnd }
        val painted = paintCodeSelection(selStart, selEnd, settled = settlingFromEngine)
        if (applying) return
        val e = editableText ?: return
        // The end sentinel is not a caret position (an empty Editable has none yet).
        val last = (e.length - 1).coerceAtLeast(0)
        val (a, b) = clampSelectionOutOfAtoms(e, selStart.coerceAtMost(last), selEnd.coerceAtMost(last))
        if (a != selStart || b != selEnd) {
            applying = true
            try { Selection.setSelection(e, a, b) } finally { applying = false }
        }
        engine?.viewSelection(appliedSeq, painted?.start ?: a, painted?.end ?: b, placed = !movingSelectionItself)
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
        if (codeTouch.onTouch(event)) return true
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
        return super.onTouchEvent(event).also { imageTouch.settleSelection(); codeTouch.settleTap(event); lineBelowHandle.onTouch(event) }
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

    // Hardware Enter must reach the engine with its original selection. Gboard
    // otherwise deletes the selection before forwarding the key, losing the
    // whole-code-body Enter intent and splitting its Undo action.
    override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean {
        if (engine != null && (keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER)) {
            return when (event.action) {
                KeyEvent.ACTION_DOWN -> onKeyDown(keyCode, event)
                KeyEvent.ACTION_UP -> true
                else -> super.onKeyPreIme(keyCode, event)
            }
        }
        return super.onKeyPreIme(keyCode, event)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val engine = engine ?: return super.onKeyDown(keyCode, event)
        if (selectedBlockKey(keyCode, event) || codeLineKey(keyCode, event) || codeStartBackTab(keyCode, event) || downOutOfLastBlock(keyCode, event)) return true
        if (shortcutKey(engine, keyCode, event) || engineKey(engine, keyCode, event)) return true
        return super.onKeyDown(keyCode, event) || keyCode in NOTE_MOVE_KEYS
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
            when (event.action) {
                KeyEvent.ACTION_DOWN -> super.onKeyDown(event.keyCode, event)
                KeyEvent.ACTION_UP -> super.onKeyUp(event.keyCode, event)
            }
        }
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

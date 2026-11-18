package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** A code block's header field keeps the note still and itself in view: while the keyboard rises over it, as it is typed in, and as it closes. */
class TextFirstCodeHeaderFieldRevealTest {
    /**
     * Mason's report: a hold to change the language slid the note up and left the caret in the wrong
     * place. Opening a field never scrolls the note to the note's own caret, never moves a field that
     * is already visible, and brings a field the keyboard covers above it; the note draws no caret
     * while a field has the keyboard.
     */
    @Test fun openingAHeaderFieldKeepsTheNoteStillAndTheFieldInView() = textFirstSession("```js\nconst a = 1\n```\n" + "line\n".repeat(80) + "```py\nb = 2\n```\n" + "end\n".repeat(40)) { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.codeChrome.areaOf(0, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        // The note's caret far below, where a reveal of it would scroll the note.
        textFirstIme(c) { setSelection(view.length() - 10, view.length() - 10) }
        c.sourceText()
        view.scrollTo(0, 0)
        delay(300)
        val area = view.codeChrome.areaOf(0, CodeBlockAction.LANGUAGE_LABEL)!!
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop + area.centerY())
        val field = openHeaderField(view)
        withTimeout(5_000) { while (field.height <= 1) delay(20) }
        val top = field.top
        // Whatever the keyboard does meanwhile (it may resize the window), give it time.
        delay(1_500)
        assertEquals("the note scrolled while a visible field opened", 0, view.scrollY)
        assertEquals("the open field moved", top, field.top)
        assertEquals("the note's caret is drawn while a field is open", false, view.isFocused)
    }

    /**
     * Mason's report and verifier run 2 (D2): a field the rising keyboard covered was left under it, and
     * the note jumped when it closed. It is brought into view, even once its header is no longer drawn.
     */
    @Test fun aFieldTheKeyboardCoversIsBroughtIntoView() = textFirstSession("line\n".repeat(30) + "```py\nb = 2\n```\n" + "end\n".repeat(60)) { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        val codeStart = view.editableText.indexOf("b = 2")
        withTimeout(5_000) { while (view.codeChrome.areaOf(codeStart, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        val area = view.codeChrome.areaOf(codeStart, CodeBlockAction.LANGUAGE_LABEL)!!
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        val field = openHeaderField(view)
        withTimeout(5_000) { while (field.height <= 1) delay(20) }
        // The keyboard rises and the window shrinks to well above the block, so its header is no longer drawn.
        val params = view.layoutParams
        params.height = (view.totalPaddingTop - view.scrollY + area.top - view.lineHeight * 3).toInt()
        view.layoutParams = params
        withTimeout(5_000) { while (view.height != params.height) delay(20) }
        delay(1_000)
        val codeLineTop = view.totalPaddingTop - view.scrollY + view.layout.getLineTop(view.layout.getLineForOffset(codeStart))
        assert(codeLineTop <= view.height) { "the block (code line at $codeLineTop) stayed under the keyboard (note height ${view.height})" }
        assert(field.top >= view.top) { "the field went above the note" }
        // Typing writes the fence; the note stays where it is and the field on its block.
        val scrolled = view.scrollY
        val input = field.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
        for (letter in "rb") {
            input.commitText(letter.toString(), 1)
            c.sourceText()
            delay(300)
            assertEquals("the note scrolled after typing $letter", scrolled, view.scrollY)
        }
        val now = view.codeChrome.areaOf(codeStart, CodeBlockAction.LANGUAGE_LABEL)!!
        assertEquals("the field left its block", view.top + view.totalPaddingTop - view.scrollY + now.top, field.top.toFloat(), 1f)
        input.sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_ENTER))
        c.sourceText()
        delay(500)
        assertEquals("leaving the field moved the note", scrolled, view.scrollY)
    }

    /** Verifier run 1, item 3: typing in the name field of the note's first block scrolled the note 52 px. */
    @Test fun typingInTheTopBlocksNameFieldLeavesTheNoteWhereItIs() = textFirstSession("```js name:server.go\nconst a = 1\n```\n" + "line\n".repeat(80)) { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.codeChrome.areaOf(0, CodeBlockAction.NAME_FIELD) == null) delay(20) }
        val area = view.codeChrome.areaOf(0, CodeBlockAction.NAME_FIELD)!!
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop + area.centerY())
        val field = openHeaderField(view)
        withTimeout(5_000) { while (field.height <= 1) delay(20) }
        delay(1_500)
        val scrolled = view.scrollY
        val input = field.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
        input.commitText("x", 1)
        c.sourceText()
        delay(300)
        assertEquals("typing moved the note", scrolled, view.scrollY)
        input.sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_ENTER))
        c.sourceText()
        delay(300)
        assertEquals("leaving the field moved the note", scrolled, view.scrollY)
    }

    /** Verifier run 2 (D2): revealing a covered field in the note's last block stays within the note, so typing does not move it back. */
    @Test fun aCoveredFieldInTheLastBlockIsRevealedWithinTheNote() = textFirstSession("line\n".repeat(40) + "```yaml\nlast: block\n```") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        val codeStart = view.editableText.indexOf("last: block")
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        view.scrollTo(0, view.maxScrollY())
        withTimeout(5_000) { while (view.codeChrome.areaOf(codeStart, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        val area = view.codeChrome.areaOf(codeStart, CodeBlockAction.LANGUAGE_LABEL)!!
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        val field = openHeaderField(view)
        withTimeout(5_000) { while (field.height <= 1) delay(20) }
        val params = view.layoutParams
        params.height = (view.totalPaddingTop - view.scrollY + area.top - view.lineHeight).toInt()
        view.layoutParams = params
        withTimeout(5_000) { while (view.height != params.height) delay(20) }
        delay(1_000)
        assert(view.scrollY <= view.maxScrollY()) { "the note scrolled to ${view.scrollY}, past its end ${view.maxScrollY()}" }
        val scrolled = view.scrollY
        val input = field.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
        input.commitText("x", 1)
        c.sourceText()
        delay(300)
        assertEquals("typing moved the note", scrolled, view.scrollY)
        // Leaving puts the caret in the code and the editor toolbar comes back (about 45 dp). At the note's end there
        // is no room kept below, so the note may move, and must, just enough that the caret's line stays in view.
        input.sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_ENTER))
        c.sourceText()
        params.height = view.height - view.style.dp(45f).toInt()
        view.layoutParams = params
        withTimeout(5_000) { while (view.height != params.height) delay(20) }
        delay(500)
        val caretLine = view.layout.getLineForOffset(view.selectionStart)
        val caretBottom = view.totalPaddingTop - view.scrollY + view.layout.getLineBottom(caretLine)
        assert(caretBottom <= view.height - view.totalPaddingBottom) { "the caret's line (bottom $caretBottom) is under the toolbar (${view.height - view.totalPaddingBottom})" }
    }

    /**
     * Verifier run 4 (report 1): a field low on the screen that the rising keyboard covers moved the note twice,
     * once before the keyboard was up and once after it resized the note. It moves once, as on !300.
     */
    @Test fun aCoveredFieldIsRevealedInOneMovement() = textFirstSession("line\n".repeat(30) + "```py\nb = 2\n```\n" + "end\n".repeat(60)) { c ->
        val view = c.view
        // The app's window neither pans nor resizes for the keyboard; its screen pads the note (imePadding), modelled below.
        (view.context as android.app.Activity).window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
        view.isFocusableInTouchMode = true
        val codeStart = view.editableText.indexOf("b = 2")
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val header = view.layout.getLineTop(view.layout.getLineForOffset(codeStart)) - view.style.codeHeaderHeight
        // The header just above the note's bottom edge, inside the room kept for the editor toolbar.
        view.scrollTo(0, (header + view.style.codeHeaderHeight * 2.5f - (view.height - view.totalPaddingTop - view.totalPaddingBottom)).toInt())
        withTimeout(5_000) { while (view.codeChrome.areaOf(codeStart, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        val area = view.codeChrome.areaOf(codeStart, CodeBlockAction.LANGUAGE_LABEL)!!
        val positions = mutableListOf(view.scrollY)
        val record = android.view.ViewTreeObserver.OnScrollChangedListener { if (positions.last() != view.scrollY) positions += view.scrollY }
        view.viewTreeObserver.addOnScrollChangedListener(record)
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        openHeaderField(view)
        fun keyboard() = androidx.core.view.ViewCompat.getRootWindowInsets(view)?.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())?.bottom ?: 0
        withTimeout(5_000) { while (keyboard() == 0) delay(20) }
        // The screen's imePadding resizes the note to the keyboard's top over the keyboard's animation, as the app does.
        val inWindow = IntArray(2).also(view::getLocationInWindow)
        val params = view.layoutParams
        val from = view.height
        val to = view.rootView.height - keyboard() - inWindow[1]
        for (step in 1..16) {
            params.height = from + (to - from) * step / 16
            view.layoutParams = params
            delay(16)
        }
        assertEquals("the field was not revealed while the keyboard rose: $positions", 2, positions.size)
        withTimeout(5_000) { while (view.height != to) delay(20) }
        delay(1_000)
        assertEquals("the note moved more than once: $positions", 2, positions.size)
        // Leaving puts the caret in the code, and the editor toolbar comes back over the keyboard (about 45 dp).
        val field = openHeaderField(view)
        field.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!
            .sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_ENTER))
        c.sourceText()
        params.height = view.height - view.style.dp(45f).toInt()
        view.layoutParams = params
        withTimeout(5_000) { while (view.height != params.height) delay(20) }
        delay(500)
        view.viewTreeObserver.removeOnScrollChangedListener(record)
        // The note moves on leaving only as far as the caret's line needs, above the returned toolbar (ruling, 2026-11-17).
        val caretLine = view.layout.getLineForOffset(view.selectionStart)
        val caretBottom = view.totalPaddingTop - view.scrollY + view.layout.getLineBottom(caretLine)
        assert(caretBottom <= view.height - view.totalPaddingBottom) { "the caret's line (bottom $caretBottom) is under the toolbar" }
    }

    /** Area 8 verifier: a field the keyboard does not cover leaves the note where it is, as on !300. */
    @Test fun aFieldAboveTheKeyboardLeavesTheNoteStill() = textFirstSession("line\n".repeat(12) + "```py\nb = 2\n```\n" + "end\n".repeat(60)) { c ->
        val view = c.view
        (view.context as android.app.Activity).window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
        view.isFocusableInTouchMode = true
        val codeStart = view.editableText.indexOf("b = 2")
        fun keyboard() = androidx.core.view.ViewCompat.getRootWindowInsets(view)?.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())?.bottom ?: 0
        // The keyboard's height first, so the block can sit just above where it will rise to.
        view.showKeyboard()
        withTimeout(5_000) { while (keyboard() == 0) delay(20) }
        val keyboardHeight = keyboard()
        view.hideKeyboard()
        withTimeout(5_000) { while (keyboard() != 0) delay(20) }
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val inWindow = IntArray(2).also(view::getLocationInWindow)
        val keyboardTop = view.rootView.height - keyboardHeight - inWindow[1]
        val header = view.layout.getLineTop(view.layout.getLineForOffset(codeStart))
        view.scrollTo(0, (view.totalPaddingTop + header + view.style.codeHeaderHeight * 1.5f - keyboardTop).toInt().coerceAtLeast(0))
        withTimeout(5_000) { while (view.codeChrome.areaOf(codeStart, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        val area = view.codeChrome.areaOf(codeStart, CodeBlockAction.LANGUAGE_LABEL)!!
        val before = view.scrollY
        assert(view.totalPaddingTop - before + area.bottom < keyboardTop) { "the field is not above the keyboard here" }
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        openHeaderField(view)
        withTimeout(5_000) { while (keyboard() == 0) delay(20) }
        delay(1_000)
        assertEquals("the note moved for a field the keyboard does not cover", before, view.scrollY)
    }

    /** Area 8 verifier: the keyboard going away with a field open closes the field to its label, as on !300. */
    @Test fun theKeyboardGoingAwayClosesTheField() = textFirstSession("```js name:server.go\nconst a = 1\n```\n\nafter") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.codeChrome.areaOf(0, CodeBlockAction.NAME_FIELD) == null) delay(20) }
        val area = view.codeChrome.areaOf(0, CodeBlockAction.NAME_FIELD)!!
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop + area.centerY())
        val field = openHeaderField(view)
        fun keyboard() = androidx.core.view.ViewCompat.getRootWindowInsets(view)?.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())?.bottom ?: 0
        withTimeout(5_000) { while (keyboard() == 0) delay(20) }
        delay(300)
        view.context.getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(field.windowToken, 0)
        withTimeout(5_000) { while (field.isAttachedToWindow) delay(20) }
        assertEquals(null, view.codeChrome.openField)
    }
}

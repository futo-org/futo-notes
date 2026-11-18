package com.futo.notes.textfirst

import android.content.ClipboardManager
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** The header acts on the block as it is now: typing or deleting on a later code line does not leave it a stale range. */
class TextFirstCodeBlockRangeTest {
    private suspend fun caretAfter(c: TextFirstController, text: String) {
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val at = view.editableText.indexOf(text) + text.length
        c.select(at)
        withTimeout(5_000) { while (view.selectionStart != at) delay(20) }
    }

    private suspend fun tapHeader(c: TextFirstController, action: CodeBlockAction) {
        val view = c.view
        val start = view.editableText.indexOf("abc")
        withTimeout(5_000) { while (view.codeChrome.areaOf(start, action) == null) delay(20) }
        val area = view.codeChrome.areaOf(start, action)!!
        tapNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
    }

    private suspend fun copied(c: TextFirstController): String {
        val clipboard = c.view.context.getSystemService(ClipboardManager::class.java)
        clipboard.setText("")
        tapHeader(c, CodeBlockAction.COPY_CODE)
        withTimeout(5_000) { while (clipboard.primaryClip?.getItemAt(0)?.text?.toString().isNullOrEmpty()) delay(50) }
        return clipboard.primaryClip!!.getItemAt(0).text.toString()
    }

    @Test fun copyAfterTypingOnALaterLineTakesTheNewText() = textFirstSession("intro\n\n```js\nabc\ndef\n```\n\nend") { c ->
        caretAfter(c, "def")
        textFirstIme(c) { commitText("ghi", 1) }
        withTimeout(5_000) { while (!c.sourceText()!!.contains("defghi")) delay(20) }
        delay(200)
        assertEquals("abc\ndefghi", copied(c))
    }

    @Test fun copyAfterDeletingOnALaterLineStopsAtTheBlock() = textFirstSession("intro\n\n```js\nabc\ndefg\n```\n\nend") { c ->
        caretAfter(c, "defg")
        textFirstIme(c) { deleteSurroundingText(2, 0) }
        withTimeout(5_000) { while (c.sourceText()!!.contains("defg")) delay(20) }
        delay(200)
        assertEquals("abc\nde", copied(c))
    }

    @Test fun aNameTapWithTheCaretOnATypedLineEditsTheName() = textFirstSession("intro\n\n```js\nabc\ndef\n```\n\nend") { c ->
        caretAfter(c, "def")
        textFirstIme(c) { commitText("ghi", 1) }
        withTimeout(5_000) { while (!c.sourceText()!!.contains("defghi")) delay(20) }
        delay(200)
        tapHeader(c, CodeBlockAction.NAME_FIELD)
        val host = c.view.parent as android.view.ViewGroup
        fun fieldOpen() = (0 until host.childCount).any { host.getChildAt(it) is android.widget.EditText && host.getChildAt(it) !== c.view }
        withTimeout(5_000) { while (!fieldOpen() && c.view.selectedCodeBlock == null) delay(20) }
        assertEquals("the name tap selected the block instead of editing", null, c.view.selectedCodeBlock)
    }

    /**
     * In a long block the header line is not restyled by an edit far below it, so its cached block end lags (2598 for
     * 2601 after three letters on line 280 of 300): the copy glyph must not read it.
     */
    @Test fun copyAfterTypingFarDownALongBlockTakesTheWholeCode() = textFirstSession("intro\n\n```txt\n" + (1..300).joinToString("\n") { "line $it" } + "\n```\n\nend") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(10_000) { while (view.layout == null) delay(20) }
        val at = view.editableText.indexOf("line 280") + 8
        c.select(at)
        withTimeout(5_000) { while (view.selectionStart != at) delay(20) }
        textFirstIme(c) { commitText("xyz", 1) }
        withTimeout(5_000) { while (!c.sourceText()!!.contains("line 280xyz")) delay(20) }
        view.scrollTo(0, 0)
        val clipboard = view.context.getSystemService(ClipboardManager::class.java)
        clipboard.setText("")
        val start = view.editableText.indexOf("line 1\n")
        withTimeout(5_000) { while (view.codeChrome.areaOf(start, CodeBlockAction.COPY_CODE) == null) delay(20) }
        val area = view.codeChrome.areaOf(start, CodeBlockAction.COPY_CODE)!!
        tapNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        withTimeout(5_000) { while (clipboard.primaryClip?.getItemAt(0)?.text?.toString().isNullOrEmpty()) delay(50) }
        val copied = clipboard.primaryClip!!.getItemAt(0).text.toString()
        assertEquals("line 300", copied.lines().last())
        assertEquals(true, copied.contains("line 280xyz"))
    }
}

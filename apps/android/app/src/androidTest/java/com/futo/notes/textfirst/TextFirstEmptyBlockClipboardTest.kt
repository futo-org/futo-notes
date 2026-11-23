package com.futo.notes.textfirst

import android.content.ClipboardManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** Sol review (job 14, 4): Cut and Copy from an empty block's menu did nothing: Cut left the block, Copy the old clipboard. */
class TextFirstEmptyBlockClipboardTest {
    private val note = "before\n\n```js\n```\n\nafter"

    private suspend fun selectTheEmptyBlock(c: TextFirstController) {
        val view = c.view
        withContext(Dispatchers.Main) { view.isFocusableInTouchMode = true; view.requestFocus() }
        // The empty block's header is the one drawn target with SELECT_BLOCK.
        withTimeout(5_000) { while ((0..view.length()).none { view.codeChrome.areaOf(it, CodeBlockAction.SELECT_BLOCK) != null }) { view.invalidate(); delay(20) } }
        val start = (0..view.length()).first { view.codeChrome.areaOf(it, CodeBlockAction.SELECT_BLOCK) != null }
        val header = view.codeChrome.areaOf(start, CodeBlockAction.SELECT_BLOCK)!!
        tapNoteAt(view, view.totalPaddingLeft + header.left + header.width() * 0.4f, view.totalPaddingTop - view.scrollY + header.centerY())
        withTimeout(5_000) { while (view.selectedCodeBlock == null) delay(20) }
    }

    @Test fun cutRemovesTheEmptyBlock() = textFirstSession(note) { c ->
        selectTheEmptyBlock(c)
        withContext(Dispatchers.Main) { c.view.onTextContextMenuItem(android.R.id.cut) }
        withTimeout(5_000) { while (c.sourceText()!!.contains("```")) delay(20) }
    }

    @Test fun copyPutsTheEmptyFenceOnTheClipboard() = textFirstSession(note) { c ->
        val clipboard = c.view.context.getSystemService(ClipboardManager::class.java)
        withContext(Dispatchers.Main) { clipboard.setPrimaryClip(android.content.ClipData.newPlainText(null, "old")) }
        selectTheEmptyBlock(c)
        withContext(Dispatchers.Main) { c.view.onTextContextMenuItem(android.R.id.copy) }
        delay(800)
        val copied = withContext(Dispatchers.Main) { clipboard.primaryClip?.getItemAt(0)?.text?.toString() }
        assertEquals("```js\n```", copied?.trim())
    }

    /** S09 (mr-729 QA): Enter in the language field of a selected empty block leaves the selection; the next letter is code, not a replacement of the block. */
    @Test fun enterInTheLanguageFieldOfASelectedEmptyBlockTypesIntoIt() = textFirstSession("```\n```") { c ->
        selectTheEmptyBlock(c)
        val view = c.view
        val start = (0..view.length()).first { view.codeChrome.areaOf(it, CodeBlockAction.LANGUAGE_LABEL) != null }
        val area = view.codeChrome.areaOf(start, CodeBlockAction.LANGUAGE_LABEL)!!
        withContext(Dispatchers.Main) { holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY()) }
        val field = withContext(Dispatchers.Main) { openHeaderField(view) }
        withContext(Dispatchers.Main) {
            field.onCreateInputConnection(android.view.inputmethod.EditorInfo())!!.sendKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_ENTER))
        }
        c.sourceText()
        withTimeout(5_000) { while (view.selectedCodeBlock != null) delay(20) }
        textFirstIme(c) { commitText("z", 1) }
        assertEquals("```\nz\n```", c.sourceText()!!.trimEnd('\n'))
    }
}

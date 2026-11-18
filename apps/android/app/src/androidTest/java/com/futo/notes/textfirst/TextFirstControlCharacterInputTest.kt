package com.futo.notes.textfirst

import android.content.ClipData
import android.content.ClipboardManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * interpretation-and-input.md: typed text holding a control character other than tab and line feed is refused; a paste
 * and a text service's replacement arrive isolated and land. Each of the app's paths is exercised with U+0001.
 */
class TextFirstControlCharacterInputTest {
    private suspend fun ready(c: TextFirstController) {
        withContext(Dispatchers.Main) { c.view.isFocusableInTouchMode = true; c.view.requestFocus() }
        withTimeout(5_000) { while (c.view.layout == null) delay(20) }
        c.select(c.view.editableText.indexOf("]"))
        c.sourceText()
    }

    @Test fun aPasteHoldingAControlCharacterLands() = textFirstSession("[]") { c ->
        ready(c)
        withContext(Dispatchers.Main) {
            val clipboard = c.view.context.getSystemService(ClipboardManager::class.java)
            clipboard.setPrimaryClip(ClipData.newPlainText("t", "a\u0001b"))
            c.view.onTextContextMenuItem(android.R.id.paste)
        }
        withTimeout(5_000) { while (c.sourceText() == "[]") delay(20) }
        assertEquals("[a\u0001b]", c.sourceText())
    }

    @Test fun aTextServiceReplacementHoldingAControlCharacterLands() = textFirstSession("[word]") { c ->
        ready(c)
        val start = c.view.editableText.indexOf("word")
        textFirstIme(c) {
            beginBatchEdit()
            setSelection(start, start + 4)
            commitText("w\u0001d", 1)
            endBatchEdit()
        }
        withTimeout(5_000) { while (c.sourceText() == "[word]") delay(20) }
        assertEquals("[w\u0001d]", c.sourceText())
    }
}

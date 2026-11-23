package com.futo.notes.textfirst

import android.content.ClipboardManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** Mason (batch 3, 7): a selected line break is drawn, so Copy and Cut carry it. */
class TextFirstLineBreakCopyTest {
    private val note = "alpha\n\nbeta\n\n- one\n- two\n"

    private suspend fun selectAndCopy(c: TextFirstController, from: Int, to: Int, cut: Boolean = false): String? {
        val view = c.view
        val clipboard = view.context.getSystemService(ClipboardManager::class.java)
        withContext(Dispatchers.Main) { view.isFocusableInTouchMode = true; view.requestFocus(); clipboard.setPrimaryClip(android.content.ClipData.newPlainText(null, "old")) }
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        c.select(from, to)
        withTimeout(5_000) { while (view.selectionStart != from || view.selectionEnd != to) delay(20) }
        withContext(Dispatchers.Main) { view.onTextContextMenuItem(if (cut) android.R.id.cut else android.R.id.copy) }
        delay(800)
        return withContext(Dispatchers.Main) { clipboard.primaryClip?.getItemAt(0)?.text?.toString() }
    }

    @Test fun copyCarriesTheBreakAfterARowsText() = textFirstSession(note) { c ->
        val at = c.view.editableText.indexOf("pha")
        assertEquals("pha\n", selectAndCopy(c, at, at + "pha\n".length))
    }

    @Test fun copyCarriesTheBreakOfARowSelectedAtItsEnd() = textFirstSession(note) { c ->
        val at = c.view.editableText.indexOf("beta")
        assertEquals("a\n\nbeta", selectAndCopy(c, at - 3, at + "beta".length))
    }

    @Test fun cutTakesTheBreakAfterAListItem() = textFirstSession(note) { c ->
        // From the item's marker unit through its break: the item's Markdown, marker and break included.
        val at = c.view.editableText.indexOf("one") - 1
        assertEquals("- one\n", selectAndCopy(c, at, at + "\uFFFCone\n".length, cut = true))
        withTimeout(5_000) { while (c.sourceText()!!.contains("one")) delay(20) }
        assertEquals("alpha\n\nbeta\n\n- two\n", c.sourceText())
    }
}

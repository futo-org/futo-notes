package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Mason's rule (engine f4b3cdb42): in a selection that holds table lines and other lines, the toolbar's Bold leaves the
 * table lines byte for byte and bolds the other lines.
 */
class TextFirstTableFormatTest {
    @Test fun boldThroughATableLeavesTheTableLines() = textFirstSession("before here\n\n| a | b |\n| - | - |\n| c | d |\n\nafter here") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val text = view.editableText.toString()
        c.select(text.indexOf("here"), text.indexOf("after") + "after".length)
        delay(300)
        c.toolbarFormat(uniffi.futo_notes_ffi.EditorInlineFormat.BOLD)
        delay(500)
        val saved = c.sourceText()!!
        assertEquals("the table lines changed", "| a | b |\n| - | - |\n| c | d |", saved.lines().filter { it.startsWith("|") }.joinToString("\n"))
        assertEquals("before **here**\n\n| a | b |\n| - | - |\n| c | d |\n\n**after** here", saved)
    }
}

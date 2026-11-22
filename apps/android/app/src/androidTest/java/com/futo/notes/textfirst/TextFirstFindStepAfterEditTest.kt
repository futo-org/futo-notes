package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Tester (round 2, F3): typing over the current match, then Next, skipped the match after it. An edit that drops the
 * current match leaves the reader on none: Next goes to the first match at or after where it was (find.md).
 */
class TextFirstFindStepAfterEditTest {
    @Test fun nextAfterTypingOverTheCurrentMatchLandsOnTheMatchAfterIt() = textFirstSession("Plain zebra\n\nbold zebra\n\nitalic zebra\n") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        c.findSetQuery("zebra")
        c.findStep(forward = true)
        val text = view.editableText.toString()
        assertEquals("the first press lands on the first match", text.indexOf("zebra"), view.selectionStart)
        textFirstIme(c) { commitText("horse", 1) }
        withTimeout(5_000) { while (!(c.sourceText() ?: "").startsWith("Plain horse")) delay(20) }
        delay(500) // the rescan settles
        c.findStep(forward = true)
        val bold = view.editableText.toString().indexOf("bold zebra") + "bold ".length
        assertEquals("Next lands on the match after the one typed over", bold to bold + 5, view.selectionStart to view.selectionEnd)
    }
}

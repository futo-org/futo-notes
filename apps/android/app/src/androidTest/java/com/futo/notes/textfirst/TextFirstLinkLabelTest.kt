package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Link form's label is the engine's `link_label`; across table cells there is none and only a destination is asked. */
class TextFirstLinkLabelTest {
    private suspend fun draftOver(c: TextFirstController, from: Int, to: Int): LinkDraft {
        withTimeout(5_000) { while (c.view.layout == null) delay(20) }
        c.select(from, to)
        withTimeout(5_000) { while (c.view.selectionStart != from || c.view.selectionEnd != to) delay(20) }
        return checkNotNull(c.linkDraft())
    }

    @Test fun acrossTwoTableCellsTheFormAsksOnlyADestination() = textFirstSession("| h1 | h2 |\n| - | - |\n| c | d |\n\nend") { c ->
        val e = c.view.editableText
        val draft = draftOver(c, e.indexOf("h1"), e.indexOf("h2") + 2)
        assertEquals(null, draft.label)
        val before = c.sourceText()
        assertTrue(c.editLink(draft, "", "https://x.org"))
        val after = c.sourceText()!!
        assertNotEquals("the link was not written", before, after)
        assertFalse("a cell-spanning label was written", after.contains("|h1|h2|") || after.contains("[h1 | h2]"))
        assertTrue("the table lost its shape", after.lines()[1] == "| - | - |")
    }

    @Test fun insideOneCellTheLabelIsTheCellsText() = textFirstSession("| h1 | h2 |\n| - | - |\n| c | d |\n\nend") { c ->
        val e = c.view.editableText
        assertEquals("h1", draftOver(c, e.indexOf("h1"), e.indexOf("h1") + 2).label)
    }

    @Test fun anExistingLinksLabelIsItsText() = textFirstSession("see [site](https://a.b) now") { c ->
        val at = c.view.editableText.indexOf("site") + 1
        assertEquals("site", draftOver(c, at, at).label)
    }

    @Test fun aPlainSelectionsLabelIsItsText() = textFirstSession("alpha beta gamma") { c ->
        val e = c.view.editableText
        assertEquals("beta", draftOver(c, e.indexOf("beta"), e.indexOf("beta") + 4).label)
    }

    @Test fun aCaretsLabelIsEmpty() = textFirstSession("alpha beta gamma") { c ->
        val at = c.view.editableText.indexOf("beta")
        assertEquals("", draftOver(c, at, at).label)
    }
}

package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Job 11 D: in the Editor demo, a tap on [[Missing note]] created and opened "Linked note-2": the target was the first
 * wikilink of the tapped one's paragraph, and a note by that name existed. A tap follows the wikilink it lands on.
 */
class TextFirstMissingWikilinkTargetTest {
    @Test fun aTapOnTheSecondMissingWikilinkOfALineFollowsThatOne() = textFirstSession("A [[First note]] that is missing and a [[Second note]] too.") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null || view.editableText.getSpans(0, view.length(), TfWikilink::class.java).size < 2) delay(20) }
        val e = view.editableText
        val second = e.getSpans(0, e.length, TfWikilink::class.java).maxBy { e.getSpanStart(it) }
        val start = e.getSpanStart(second)
        val line = view.layout.getLineForOffset(start)
        val width = second.getSize(second.renderedPaint(view.paint), e, start, e.getSpanEnd(second), null)
        val x = view.totalPaddingLeft + view.layout.getPrimaryHorizontal(start) + width / 2f
        val y = view.totalPaddingTop - view.scrollY + view.layout.getLineBaseline(line) - view.paint.textSize / 3f
        val followed = mutableListOf<WikilinkDestination>()
        view.onOpenWikilink = { followed.add(it) }
        tapNoteAt(view, x, y)
        withTimeout(5_000) { while (followed.isEmpty()) delay(20) }
        assertEquals(listOf(WikilinkDestination.Missing("Second note")), followed)
    }

    /** Mason's report: a tap on the row under "Linked note" (plain text beside [[Missing note]]) created and opened a note. */
    @Test fun aTapOnPlainTextBesideAMissingWikilinkFollowsNothing() = textFirstSession("A [[Missing note]] that does not exist.") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null || view.editableText.getSpans(0, view.length(), TfWikilink::class.java).isEmpty()) delay(20) }
        val plain = view.editableText.indexOf("exist")
        val line = view.layout.getLineForOffset(plain)
        val followed = mutableListOf<WikilinkDestination>()
        view.onOpenWikilink = { followed.add(it) }
        tapNoteAt(view, view.totalPaddingLeft + view.layout.getPrimaryHorizontal(plain) + 4f, view.totalPaddingTop - view.scrollY + view.layout.getLineBaseline(line) - view.paint.textSize / 3f)
        delay(1_000)
        assertEquals(emptyList<WikilinkDestination>(), followed)
    }
}

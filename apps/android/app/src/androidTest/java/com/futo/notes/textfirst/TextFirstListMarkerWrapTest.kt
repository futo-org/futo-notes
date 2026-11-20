package com.futo.notes.textfirst

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mason: a list of links is ordinary. An item whose first word is wider than its row keeps its marker on that word's
 * first row, as before marker units, on every API level: the Editable holds the marker unit as a no-break space.
 */
class TextFirstListMarkerWrapTest {
    private val url = "https://example.com/a/very/long/path/without/any/spaces/that/is/wider/than/the/whole/column"
    private val note = "- $url\n- [ ] $url\n10. $url\n\nend"

    @Test fun aMarkerSharesItsRowWithAnOverLongFirstWord() = textFirstSession(note) { c ->
        withTimeout(5_000) { while (withContext(Dispatchers.Main) { c.view.layout == null || c.view.editableText.getSpans(0, c.view.length(), TfListMarker::class.java).size < 3 }) delay(20) }
        withContext(Dispatchers.Main) {
            val view = c.view
            val l = view.layout
            val e = view.editableText
            val markers = e.getSpans(0, e.length, TfListMarker::class.java).map { e.getSpanStart(it) }.sorted()
            for ((marker, kind) in markers.zip(listOf("bullet", "task", "10."))) {
                assertTrue("$kind: the link wraps", l.getLineForOffset(marker + url.length) > l.getLineForOffset(marker))
                assertEquals("$kind: the marker and the link's first characters share a row", l.getLineForOffset(marker), l.getLineForOffset(marker + 5))
            }
            // The view holds a no-break space where the engine has the marker unit; TalkBack reads it as a silent space.
            assertEquals('\u00A0', view.text!![markers[0]])
            assertTrue("TalkBack reads a space at the marker", view.createAccessibilityNodeInfo().text.toString().startsWith("\u00A0https"))
        }
    }
}

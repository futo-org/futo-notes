package com.futo.notes

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import com.futo.notes.ui.components.parseInlinePreview
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit coverage for the Compose inline-markdown preview parser — the Android
 * counterpart of iOS's `AttributedString(markdown: .inlineOnlyPreservingWhitespace)`.
 * The block-markdown rewrite (☐/☑, •, dropped tables, stripped headings) is the
 * shared Rust `make_rich_preview` (tested in futo-notes-model); these tests pin
 * the inline emphasis the renderer adds on top.
 */
class InlineMarkdownTest {
    private val code = Color(0xFFF26B1F)

    @Test
    fun stripsMarkersFromPlainText() {
        val out = parseInlinePreview("a **b** c *d* `e` ~~f~~", code)
        // The markup characters are gone; only the content remains.
        assertEquals("a b c d e f", out.text)
    }

    @Test
    fun boldSpansOnlyTheBoldRun() {
        val out = parseInlinePreview("hi **there** you", code)
        assertEquals("hi there you", out.text)
        val span = out.spanStyles.single()
        assertEquals(FontWeight.Bold, span.item.fontWeight)
        assertEquals("hi ".length, span.start)
        assertEquals("hi there".length, span.end)
    }

    @Test
    fun italicUnderscoreAndAsterisk() {
        assertEquals(FontStyle.Italic, parseInlinePreview("_x_", code).spanStyles.single().item.fontStyle)
        assertEquals(FontStyle.Italic, parseInlinePreview("*x*", code).spanStyles.single().item.fontStyle)
    }

    @Test
    fun codeIsMonospaceAndColored() {
        val span = parseInlinePreview("run `cmd` now", code).spanStyles.single().item
        assertEquals(FontFamily.Monospace, span.fontFamily)
        assertEquals(code, span.color)
    }

    @Test
    fun strikethrough() {
        val span = parseInlinePreview("~~gone~~", code).spanStyles.single().item
        assertEquals(TextDecoration.LineThrough, span.textDecoration)
    }

    @Test
    fun preservesNewlinesAndGlyphs() {
        // make_rich_preview emits ☐/☑/• glyphs + newlines; the parser must keep them.
        val out = parseInlinePreview("☐ milk\n☑ coffee\n• eggs", code)
        assertEquals("☐ milk\n☑ coffee\n• eggs", out.text)
        assertTrue(out.spanStyles.isEmpty())
    }

    @Test
    fun unmatchedMarkersAreLiteral() {
        // A lone marker with no closer is emitted verbatim, never throws.
        val out = parseInlinePreview("2 * 3 = 6 and a ** lone", code)
        assertEquals("2 * 3 = 6 and a ** lone", out.text)
        assertNull(out.spanStyles.firstOrNull()?.item?.fontWeight)
    }
}

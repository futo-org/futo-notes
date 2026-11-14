package com.futo.notes

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import com.futo.notes.ui.components.parseInlinePreview
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

    @Test
    fun nestedSpansComposeAndIntrawordUnderscoresStayLiteral() {
        val out = parseInlinePreview(
            "a ~~*nested*~~ b **bold `code`** c ***both*** d snake_case_name e __under__",
            code,
        )
        assertEquals("a nested b bold code c both d snake_case_name e under", out.text)
        val nested = out.stylesAt("nested")
        assertTrue(nested.any { it.textDecoration == TextDecoration.LineThrough })
        assertTrue(nested.any { it.fontStyle == FontStyle.Italic })
        val codeStyles = out.stylesAt("code")
        assertTrue(codeStyles.any { it.fontWeight == FontWeight.Bold })
        assertTrue(codeStyles.any { it.fontFamily == FontFamily.Monospace })
        val both = out.stylesAt("both")
        assertTrue(both.any { it.fontWeight == FontWeight.Bold })
        assertTrue(both.any { it.fontStyle == FontStyle.Italic })
        assertTrue(out.stylesAt("snake_case_name").isEmpty())
        val under = out.stylesAt("under")
        assertTrue(under.any { it.fontWeight == FontWeight.Bold })
        assertFalse(under.any { it.fontStyle == FontStyle.Italic })
    }

    @Test
    fun backslashEscapesAreLiteralAndNeverDelimiters() {
        val escaped = parseInlinePreview("a \\*not italic\\* b \\`c\\` x \\\\ y \\q", code)
        assertEquals("a *not italic* b `c` x \\ y \\q", escaped.text)
        assertTrue(escaped.spanStyles.isEmpty())

        val unequal = parseInlinePreview("lpha **beta*\\* gamma", code)
        assertEquals("lpha *beta* gamma", unequal.text)
        assertEquals(listOf(FontStyle.Italic), unequal.stylesAt("beta").map { it.fontStyle })
        assertNull(unequal.spanStyles.single().item.fontWeight)

        val innerOpener = parseInlinePreview("**foo *x*", code)
        assertEquals("**foo x", innerOpener.text)
        assertEquals(FontStyle.Italic, innerOpener.stylesAt("x").single().fontStyle)
    }

    @Test(timeout = 2000)
    fun unclosedOpenersStayFast() {
        val src = "*a ".repeat(100)
        assertEquals(src, parseInlinePreview(src, code).text)
    }

    private fun AnnotatedString.stylesAt(word: String): List<SpanStyle> {
        val start = text.indexOf(word)
        val end = start + word.length
        return spanStyles.filter { it.start <= start && it.end >= end }.map { it.item }
    }
}

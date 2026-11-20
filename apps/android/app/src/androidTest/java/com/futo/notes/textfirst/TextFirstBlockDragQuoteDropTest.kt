package com.futo.notes.textfirst

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Mason (S23): an empty code block dropped among quote lines, where the drop joins two quote runs and splits another,
 * left the lines around it drawn with the wrong block styles (a quote line with the code's gutter and indent, the code
 * card doubled, a quote bar running through the code). After the drop every line carries its own block's spans only.
 */
class TextFirstBlockDragQuoteDropTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val tail = "> - List inside a quote\n\n```kotlin\nfun main() {\n    println(\"code\")\n}\n```\n"

    /** Each line's quote depth and whether it is code, as drawn, against [source]; no line both, no span starting mid-line. */
    private fun BlockDragRig.assertEachLineHasItsOwnSpans(source: String) {
        val drawn = ui {
            val l = view.layout
            val e = view.editableText
            (0 until l.lineCount).map { line ->
                val a = l.getLineStart(line)
                val b = l.getLineEnd(line)
                // A list item's row starts with its marker unit, a no-break space here, which trim() drops.
                Triple(e.subSequence(a, b).toString().trim(),
                    e.getSpans(a, a + 1, TfQuote::class.java).maxOfOrNull { it.depth } ?: 0,
                    e.getSpans(a, a + 1, TfCodeBlock::class.java).isNotEmpty())
            }
        }
        for ((text, depth, code) in drawn) {
            if (text.isEmpty() || text == TextFirstEditText.END_SENTINEL) continue
            val sourceLine = source.lines().first { it.replace("*", "").endsWith(text) }
            val expected = sourceLine.takeWhile { it == '>' || it == ' ' }.count { it == '>' }
            assertEquals("'$text': quote depth as drawn", expected, depth)
            assertEquals("'$text': code as drawn", text in setOf("fun main() {", "println(\"code\")", "}"), code)
        }
        val (quoteOnCode, starts) = ui {
            val l = view.layout
            val e = view.editableText
            val lineStarts = (0 until l.lineCount).map { l.getLineStart(it) }.toSet() + e.length
            val both = (0 until l.lineCount).count { line ->
                val a = l.getLineStart(line)
                e.getSpans(a, a + 1, TfQuote::class.java).isNotEmpty() && e.getSpans(a, a + 1, TfCodeBlock::class.java).isNotEmpty()
            }
            val off = (e.getSpans(0, e.length, TfQuote::class.java).toList<Any>() + e.getSpans(0, e.length, TfCodeBlock::class.java).toList())
                .count { e.getSpanStart(it) !in lineStarts }
            both to off
        }
        val doubled = ui {
            val l = view.layout
            (0 until l.lineCount).count { line -> l.getLineStart(line).let { a -> view.editableText.getSpans(a, a + 1, TfCodeBlock::class.java).size > 1 } }
        }
        assertEquals("rows drawn with two code spans", 0, doubled)
        assertEquals("lines drawn as both quote and code", 0, quoteOnCode)
        assertEquals("block spans that start inside a line", 0, starts)
    }

    /** Lift the empty block, carry it down until the gap is just before the nested quote, drop there. */
    private fun dropBeforeTheNestedQuote(middle: String, rowAbove: Boolean = false) = compose.openDragScreen("100) Hundred with a paren\n\n$middle$tail") {
        val original = file.readText()
        val press = ui { view.editableText.let { e -> e.getSpans(0, e.length, TfCodeBlock::class.java).filter { it.line.first }.minOf { e.getSpanStart(it) } } }
        // The slot just above the nested quote's line, or (rowAbove) above the row before it.
        val nested = ui { view.text.toString().let { t -> t.lastIndexOf('\n', t.indexOf("Nested quote")) + 1 } } - if (rowAbove) 1 else 0
        val from = at(press)
        down(from); hold(600)
        assertTrue("lifted", lifted)
        val at = carryUntil(from, 2f) { report?.gap == BlockSlot(nested, false) }
        up(at)
        compose.waitUntil(3_000) { !lifted }
        // The landing's last frame.
        SystemClock.sleep(Slide.SLIDE_MS + 600)
        val saved = file.readText()
        assertTrue("the block moved down", saved.lines().indexOf("```Hii") > original.lines().indexOf("```Hii"))
        assertEachLineHasItsOwnSpans(saved)
    }

    @Test fun aBlockDroppedBeforeANestedQuoteJoiningTwoQuoteLines() =
        dropBeforeTheNestedQuote("> Quote line one\n```Hii\n```\n> Quote line two with **bold**\n\n>> Nested quote\n")

    /** Mason's drag (log: the slot one row below the block's home, before the blank line ahead of the nested quote). */
    @Test fun aBlockDroppedOneRowDownBetweenQuoteLines() =
        dropBeforeTheNestedQuote("> Quote line one\n```Hii\n```\n> Quote line two with **bold**\n\n>> Nested quote\n", rowAbove = true)

    @Test fun aBlockDroppedBeforeANestedQuoteFromJustAboveIt() =
        dropBeforeTheNestedQuote("> Quote line one\n> Quote line two with **bold**\n```Hii\n```\n\n>> Nested quote\n")
}

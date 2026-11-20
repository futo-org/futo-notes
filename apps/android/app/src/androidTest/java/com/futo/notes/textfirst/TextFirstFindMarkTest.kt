package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mason (job 13, batch 2): the current find match showed no mark inside a wikilink or inline code. Every current match
 * is marked, whatever it sits in, and a query with no match leaves nothing painted.
 */
class TextFirstFindMarkTest {
    private val note = "# Heading zeta\n\nplain eta\n\n**bold theta**\n\n`code iota`\n\n#kappa\n\n[web lambda](https://example.com)\n\n[[Wiki mu]]\n\n```\ncode nu\n```\n\nend\n"

    private suspend fun render(view: TextFirstEditText): Bitmap = withContext(Dispatchers.Main) {
        Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { Canvas(it).apply { drawColor(Color.WHITE); view.draw(this) } }
    }

    /** Pixels that changed between [a] and [b] in the rectangle. */
    private fun changed(a: Bitmap, b: Bitmap, left: Int, top: Int, right: Int, bottom: Int): Int {
        var count = 0
        for (y in maxOf(0, top) until minOf(a.height, bottom)) for (x in maxOf(0, left) until minOf(a.width, right)) if (a.getPixel(x, y) != b.getPixel(x, y)) count++
        return count
    }

    @Test fun everyCurrentMatchIsMarkedWhateverItSitsIn() = textFirstSession(note) { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        delay(300)
        val plain = render(view)
        for (word in listOf("zeta", "eta", "theta", "iota", "kappa", "lambda", "mu", "nu")) {
            c.findSetQuery(word)
            c.findStep(forward = true)
            delay(300)
            val found = render(view)
            val text = view.editableText.toString()
            val at = Regex("\\b$word\\b").find(text)!!.range.first
            val l = view.layout
            val line = l.getLineForOffset(at)
            val top = view.totalPaddingTop - view.scrollY + l.getLineTop(line)
            val bottom = view.totalPaddingTop - view.scrollY + l.getLineBottom(line)
            // The word's own columns; a wikilink's whole label, which it draws as one object.
            val atom = view.editableText.getSpans(at, at, TfWikilink::class.java).firstOrNull()
            val from = atom?.let { view.editableText.getSpanStart(it) } ?: at
            val to = atom?.let { view.editableText.getSpanEnd(it) } ?: (at + word.length)
            val left = view.totalPaddingLeft + l.getPrimaryHorizontal(from).toInt()
            val right = view.totalPaddingLeft + (if (atom != null) l.getLineRight(line) else l.getPrimaryHorizontal(to)).toInt()
            assertEquals("the note scrolled", 0, view.scrollY)
            assertTrue("the current match of $word is marked", changed(plain, found, left, top, right, bottom) > 50)
        }
    }

    @Test fun aQueryWithNoMatchPaintsNothing() = textFirstSession(note) { c ->
        val view = c.view
        // The landed selection collapses to a caret at its match, in the code block: the plain note is drawn with the
        // caret there (its line number active), and without a blinking caret, so only marks would differ.
        withContext(Dispatchers.Main) { view.isCursorVisible = false }
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        c.select(view.editableText.toString().indexOf("nu", view.editableText.toString().indexOf("code nu")))
        delay(300)
        val plain = render(view)
        c.findSetQuery("nu")
        c.findStep(forward = true)
        delay(300)
        c.findSetQuery("nothing here")
        delay(300)
        assertEquals("pixels changed from the plain note", 0, changed(plain, render(view), 0, 0, view.width, view.height))
    }

    /** Sol review (batch 2, 3): letting go of the old match keeps the reader where they scrolled. */
    @Test fun aQueryWithNoMatchLeavesTheScroll() = textFirstSession((1..100).joinToString("\n\n") { "filler paragraph $it" } + "\n\nneedle\n") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        c.findSetQuery("needle")
        c.findStep(forward = true)
        delay(500)
        withContext(Dispatchers.Main) { view.scrollTo(0, 0) }
        delay(300)
        c.findSetQuery("absent")
        delay(800)
        assertEquals("the scroll after a query with no match", 0, withContext(Dispatchers.Main) { view.scrollY })
    }

    /** Mason (batch 2): the current match inside a link was orange text on the orange mark. Its text takes the note's text colour. */
    @Test fun theCurrentMatchInALinkReadsOnItsMark() = textFirstSession("[web zap link](https://example.com)\n\nend\n") { c ->
        val view = c.view
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        c.findSetQuery("zap")
        c.findStep(forward = true)
        delay(300)
        val shot = render(view)
        val l = view.layout
        val at = view.editableText.toString().indexOf("zap")
        val line = l.getLineForOffset(at)
        var darkest = 255
        for (y in view.totalPaddingTop - view.scrollY + l.getLineTop(line) until view.totalPaddingTop - view.scrollY + l.getLineBottom(line)) {
            for (x in view.totalPaddingLeft + l.getPrimaryHorizontal(at).toInt() until view.totalPaddingLeft + l.getPrimaryHorizontal(at + 3).toInt()) {
                val p = shot.getPixel(x, y)
                darkest = minOf(darkest, (Color.red(p) * 299 + Color.green(p) * 587 + Color.blue(p) * 114) / 1000)
            }
        }
        val text = view.style.textColor
        val textLuminance = (Color.red(text) * 299 + Color.green(text) * 587 + Color.blue(text) * 114) / 1000
        assertTrue("the match's text is drawn as dark as the note's text ($darkest against $textLuminance)", darkest <= textLuminance + 20)
    }
}

package com.futo.notes.textfirst

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.EditorInlineFormat

class TextFirstWholeNoteFormatTest {
    @Test fun aWholeNoteFormatShowsOnTheFirstScreenWhileBackgroundRestylingWaits() = exercise {
        engine.handler.post { engine.streamTail(0) }
        awaitComplete()
        engine.holdRender(true)
        engine.selectAll()
        engine.toggleFormat(EditorInlineFormat.BOLD)
        barrier()
        val last = display().trimEnd().length - 1
        assertTrue("the command's result shows at once on the first screen", boldAt(0))
        assertFalse("the rest of the restyle waits for the hold", boldAt(last))
        engine.holdRender(false)
        awaitComplete()
        assertTrue(boldAt(last))
    }

    @Test fun aWholeNoteFormatShowsOnAScrolledScreenAtOnceAndKeepsItsTopLine() = exercise(
        (0 until 300).joinToString("") { p -> (0 until 40).joinToString(" ") { "lambda$p" } + "\n\n" },
    ) {
        engine.handler.post { engine.streamTail(0) }
        awaitComplete()
        var top = 0
        var bottom = 0
        ui {
            val v = controller.view
            val l = v.layout
            val line = l.getLineForOffset(v.length() / 2) + 2
            v.scrollTo(0, l.getLineTop(line) + v.totalPaddingTop)
            top = l.getLineStart(line)
            bottom = l.getLineStart(l.getLineForVertical(v.scrollY - v.totalPaddingTop + v.height - 1))
        }
        engine.holdRender(true)
        engine.selectAll()
        engine.toggleFormat(EditorInlineFormat.BOLD)
        barrier()
        val last = display().trimEnd().length - 1
        assertTrue("the screen's first line is bold at once", boldAt(top))
        assertTrue("and its last", boldAt(bottom))
        assertTrue("the reader's top line stays at the top", topLineHolds(top))
        assertFalse("the rest of the restyle waits for the hold", boldAt(last))
        engine.holdRender(false)
        awaitComplete()
        assertTrue(boldAt(last))
        assertTrue(boldAt(0))
        assertTrue(topLineHolds(top))
    }

    private fun StreamingRig.boldAt(at: Int): Boolean {
        var bold = false
        ui { bold = controller.view.editableText.getSpans(at, at + 1, TfInline::class.java).any { it.bold } }
        return bold
    }

    private fun StreamingRig.topLineHolds(offset: Int): Boolean {
        var holds = false
        ui {
            val v = controller.view
            val line = v.layout.getLineForVertical(v.scrollY - v.totalPaddingTop)
            holds = offset in v.layout.getLineStart(line) until v.layout.getLineEnd(line)
        }
        return holds
    }

    private fun exercise(body: String? = null, check: StreamingRig.() -> Unit) = streamingExercise(body, check)
}

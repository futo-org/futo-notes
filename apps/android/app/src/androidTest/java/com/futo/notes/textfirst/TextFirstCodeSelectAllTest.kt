package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** Area 6 verifier (P128, P156): Select All paints every block it takes as its card, and nothing more. */
class TextFirstCodeSelectAllTest {
    @Test fun selectAllOverTwoTouchingBlocksTakesBothWhole() = textFirstSession("```js\nconst a = 1\n```\n```rust\nlet b = 2;\n```") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        view.engine!!.selectAll()
        withTimeout(5_000) { while (view.selectionEnd - view.selectionStart < view.editableText.indexOf("let b")) delay(20) }
        delay(300)
        assertEquals("the first block is not painted whole", true, view.isCodeBlockTakenWhole(0))
        assertEquals("the second block is not painted whole", true, view.isCodeBlockTakenWhole(view.editableText.indexOf("let b")))
    }

    /** S30 (mr-729 QA): an empty block ending the note starts where Select All ends, and deleting the selection takes it: it is painted whole. */
    @Test fun selectAllTakesAnEmptyBlockAtTheEndOfTheNoteWhole() = textFirstSession("a\n```\n```") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        view.engine!!.selectAll()
        withTimeout(5_000) { while (view.selectionEnd - view.selectionStart < 2) delay(20) }
        delay(300)
        val block = view.editableText.getSpans(0, view.editableText.length, TfCodeBlock::class.java).first()
        assertEquals("the empty block is not painted whole", true, view.isCodeBlockTakenWhole(view.editableText.getSpanStart(block)))
    }

    @Test fun selectAllPaintsNoBandBesideABlocksLastLine() = textFirstSession("intro line\n```js\nconst a = 1\nconst b = 2\n```\nouter line") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        view.engine!!.selectAll()
        withTimeout(5_000) { while (view.selectionEnd - view.selectionStart < view.editableText.indexOf("outer")) delay(20) }
        delay(300)
        val bitmap = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
        view.draw(android.graphics.Canvas(bitmap))
        val l = view.layout
        fun besideLine(offset: Int): Int {
            val line = l.getLineForOffset(offset)
            return bitmap.getPixel(view.width - view.totalPaddingRight - view.style.dp(20f).toInt(), view.totalPaddingTop - view.scrollY + l.getLineBaseline(line) - 4)
        }
        assertEquals("the last code line carries a band the first does not", besideLine(view.editableText.indexOf("const a")), besideLine(view.editableText.indexOf("const b")))
    }

    /**
     * P155, as on desktop (Mason): a line format over a selection running through a block changes only the text lines,
     * and the block's bytes stay as they are; the code toggle never unwraps a block selected as one object.
     */
    @Test fun blockCommandsLeaveASelectionThatTakesABlockAlone() = textFirstSession("intro line\n\n```js\nconst a = 1\n```\n\nouter line") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val before = c.sourceText()
        view.engine!!.selectAll()
        withTimeout(5_000) { while (view.selectionEnd - view.selectionStart < view.editableText.indexOf("outer")) delay(20) }
        delay(300)
        c.block(uniffi.futo_notes_ffi.EditorBlockCommand.Quote)
        delay(300)
        assertEquals("> intro line\n> \n```js\nconst a = 1\n```\n> \n> outer line", c.sourceText())
        c.undo()
        assertEquals(before, c.sourceText())
        // The code toggle on a block selected as one object leaves it a block.
        val start = view.editableText.indexOf("const a")
        val header = view.codeChrome.areaOf(start, CodeBlockAction.SELECT_BLOCK)!!
        tapNoteAt(view, view.totalPaddingLeft + header.centerX(), view.totalPaddingTop - view.scrollY + header.centerY())
        withTimeout(5_000) { while (view.selectedCodeBlock == null) delay(20) }
        c.block(uniffi.futo_notes_ffi.EditorBlockCommand.WrapCodeBlock)
        delay(300)
        assertEquals("the code toggle unwrapped the selected block", before, c.sourceText())
    }
}

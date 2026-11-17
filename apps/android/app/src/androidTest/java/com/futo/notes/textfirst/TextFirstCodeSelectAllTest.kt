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
}

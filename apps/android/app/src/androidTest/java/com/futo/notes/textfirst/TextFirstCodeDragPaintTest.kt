package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

/** Area 7 verifier (P159): a selection anchored in code and dragged to the note's very end stays painted within the code. */
class TextFirstCodeDragPaintTest {
    @Test fun aDragFromCodeToTheNotesEndPaintsOnlyTheCode() = textFirstSession("intro line\n\n```js\nconst a = 1\nconst b = 2\n```\n\nouter line\n") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val anchor = view.editableText.indexOf("a = 1")
        val codeEnd = view.editableText.indexOf("b = 2") + "b = 2".length
        view.setSelection(anchor, anchor)
        delay(200)
        // A handle dragged to the end: the view clamps the end off its end marker as it reports it.
        view.setSelection(anchor, view.length())
        delay(300)
        val painted = view.codeSelection
        assertEquals("the paint left the code", anchor to codeEnd, painted?.let { it.start to it.end })
    }
}

package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertFalse
import org.junit.Test

/** Mason (9A): a toolbar button that would change nothing is shown disabled. The code toggle on a selected block. */
class TextFirstToolbarDisabledTest {
    @Test fun theCodeToggleIsDisabledOnASelectedBlockOnly() = textFirstSession("alpha\n\n```js\ncode\n```\n\nend") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        c.select(2)
        withTimeout(5_000) { while (view.selectionStart != 2) delay(20) }
        c.sourceText()
        assertFalse(c.caret.disabled.contains("code-block"))
        view.engine!!.selectCodeBlock(view.editableText.indexOf("code"))
        withTimeout(5_000) { while (!c.caret.disabled.contains("code-block")) delay(20) }
        c.select(2)
        withTimeout(5_000) { while (c.caret.disabled.contains("code-block")) delay(20) }
    }
}

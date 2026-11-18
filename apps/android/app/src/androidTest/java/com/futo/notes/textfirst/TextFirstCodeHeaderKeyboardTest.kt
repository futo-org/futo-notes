package com.futo.notes.textfirst

import android.text.InputType
import android.view.inputmethod.EditorInfo
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mason (18B): the header fields' keyboard has capitals and suggestions, as !300's had; a composition still writes the fence. */
class TextFirstCodeHeaderKeyboardTest {
    @Test fun theLanguageFieldAsksForCapitalsAndSuggestionsAndAComposedWordWritesTheFence() = textFirstSession("```js\nconst a = 1\n```\n\nafter") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val start = view.editableText.indexOf("const")
        withTimeout(5_000) { while (view.codeChrome.areaOf(start, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        val area = view.codeChrome.areaOf(start, CodeBlockAction.LANGUAGE_LABEL)!!
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        val field = openHeaderField(view)
        val info = EditorInfo()
        val input = field.onCreateInputConnection(info)!!
        assertTrue("no capitals", info.inputType and InputType.TYPE_TEXT_FLAG_CAP_SENTENCES != 0)
        assertEquals("suggestions off", 0, info.inputType and InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
        input.setComposingText("Pyth", 1)
        withTimeout(5_000) { while (!c.sourceText()!!.startsWith("```Pyth\n")) delay(20) }
        input.setComposingText("Python", 1)
        input.finishComposingText()
        withTimeout(5_000) { while (!c.sourceText()!!.startsWith("```Python\n")) delay(20) }
        assertEquals("```Python\nconst a = 1\n```\n\nafter", c.sourceText())
    }
}

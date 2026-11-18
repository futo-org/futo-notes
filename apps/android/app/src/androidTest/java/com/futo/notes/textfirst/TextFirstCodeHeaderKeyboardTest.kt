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

    private suspend fun openField(c: TextFirstController, action: CodeBlockAction): android.widget.EditText {
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val start = view.editableText.indexOf("const")
        withTimeout(5_000) { while (view.codeChrome.areaOf(start, action) == null) delay(20) }
        val area = view.codeChrome.areaOf(start, action)!!
        holdNoteAt(view, view.totalPaddingLeft + area.centerX(), view.totalPaddingTop - view.scrollY + area.centerY())
        return openHeaderField(view)
    }

    /** FUTO's suggestion pick: the word committed over the composition, then its own space. */
    private suspend fun pickSuggestion(field: android.widget.EditText, composed: String, word: String) {
        val input = field.onCreateInputConnection(EditorInfo())!!
        input.setComposingText(composed, 1)
        delay(200)
        input.commitText(word, 1)
        delay(200)
        input.commitText(" ", 1)
        delay(400)
    }

    /** Mason: a picked suggestion must not leave `Python-` (FUTO commits the word, then its own space). */
    @Test fun aPickedLanguageSuggestionWritesTheWordWithoutAHyphen() = textFirstSession("```js\nconst a = 1\n```\n\nafter") { c ->
        val field = openField(c, CodeBlockAction.LANGUAGE_LABEL)
        field.selectAll()
        pickSuggestion(field, "pyth", "Python")
        assertEquals("```Python\nconst a = 1\n```\n\nafter", c.sourceText())
        assertEquals("Python ", field.text.toString())
        field.onCreateInputConnection(EditorInfo())!!.commitText("x", 1)
        withTimeout(5_000) { while (!c.sourceText()!!.startsWith("```Python-x\n")) delay(20) }
        assertEquals("Python-x", field.text.toString())
    }

    @Test fun cSpaceSharpIsCSharp() = textFirstSession("```js\nconst a = 1\n```\n\nafter") { c ->
        val field = openField(c, CodeBlockAction.LANGUAGE_LABEL)
        field.selectAll()
        val input = field.onCreateInputConnection(EditorInfo())!!
        for (typed in listOf("c", " ", "sharp")) { input.commitText(typed, 1); delay(150) }
        withTimeout(5_000) { while (!c.sourceText()!!.startsWith("```c-sharp\n")) delay(20) }
        assertEquals("c-sharp", field.text.toString())
    }

    @Test fun closingTheLanguageWithASpaceAtItsEndLeavesItWithout() = textFirstSession("```js\nconst a = 1\n```\n\nafter") { c ->
        val field = openField(c, CodeBlockAction.LANGUAGE_LABEL)
        field.selectAll()
        pickSuggestion(field, "ru", "rust")
        field.onEditorAction(EditorInfo.IME_ACTION_GO)
        delay(400)
        assertEquals("```rust\nconst a = 1\n```\n\nafter", c.sourceText())
    }

    /** The same pick in the name field: the fence refuses a name ending in a space, so the name is written without it. */
    @Test fun aPickedNameSuggestionWritesTheName() = textFirstSession("```js\nconst a = 1\n```\n\nafter") { c ->
        val field = openField(c, CodeBlockAction.NAME_FIELD)
        field.setSelection(field.length())
        pickSuggestion(field, "serv", "server")
        withTimeout(5_000) { while (!c.sourceText()!!.contains("server")) delay(20) }
        assertEquals("```js name:server\nconst a = 1\n```\n\nafter", c.sourceText())
    }

    /** The engine's rule: a header field keeps no backtick, and the fence is written without it. */
    @Test fun aTypedBacktickIsNotKept() = textFirstSession("```js\nconst a = 1\n```\n\nafter") { c ->
        val field = openField(c, CodeBlockAction.NAME_FIELD)
        val input = field.onCreateInputConnection(EditorInfo())!!
        for (typed in listOf("a", "`", "b")) { input.commitText(typed, 1); delay(150) }
        withTimeout(5_000) { while (!c.sourceText()!!.contains("name:ab")) delay(20) }
        assertEquals("ab", field.text.toString())
    }
}

package com.futo.notes.textfirst

import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Every toolbar item in every state: whether the toolbar shows it disabled (the engine's toolbar snapshot) and whether
 * running its command changed anything (the note's bytes, the selection, or the formats typing would carry). Run with
 * `-Pandroid.testInstrumentationRunnerArguments.toolbarAudit=true`; the table goes to logcat under `ToolbarAudit`.
 */
class TextFirstToolbarAuditTest {
    private val note = "---\ntitle: x\n---\n\nalpha beta\n\n- item\n\n```js\ncode\n```\n\n---\n\n| a | b |\n| - | - |\n| c | d |\n\n![i](missing.png)\n\nend"
    private val items = listOf(
        "undo", "redo", "bold", "italic", "strikethrough", "paragraph", "heading-1", "heading-2", "heading-3", "quote",
        "code-block", "bullet-list", "ordered-list", "task-list", "outdent", "indent",
    )

    private suspend fun settle(c: TextFirstController) { c.sourceText(); delay(250) }

    private fun audit(state: String, setUp: suspend (TextFirstController) -> Unit) = textFirstSession(note) { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        setUp(c)
        settle(c)
        val disabled = c.caret.disabled
        val row = items.map { item ->
            val source = c.sourceText()
            val selection = view.selectionStart to view.selectionEnd
            val formats = c.caret.formats
            runToolbar(c, item)
            settle(c)
            val what = buildString {
                if (c.sourceText() != source) append("b")
                if ((view.selectionStart to view.selectionEnd) != selection) append("s")
                if (c.caret.formats != formats) append("f")
            }
            val changed = what.isNotEmpty()
            if (c.sourceText() != source && item != "undo" && item != "redo") { c.undo(); settle(c) }
            if (item == "undo" && c.sourceText() != source) { c.redo(); settle(c) }
            if (item == "redo" && c.sourceText() != source) { c.undo(); settle(c) }
            if (c.caret.formats != formats && c.sourceText() == source) { runToolbar(c, item); settle(c) }
            val shown = if (item in disabled) "disabled" else "enabled"
            "$item=$shown/${if (changed) "acts($what)" else "nothing"}"
        }
        Log.i("ToolbarAudit", "$state | ${row.joinToString(" ")}")
    }

    private suspend fun caretAfter(c: TextFirstController, text: String) {
        val at = c.view.editableText.indexOf(text) + 2
        c.select(at)
        withTimeout(5_000) { while (c.view.selectionStart != at) delay(20) }
    }

    private suspend fun selectRange(c: TextFirstController, from: Int, to: Int) {
        c.select(from, to)
        withTimeout(5_000) { while (c.view.selectionEnd != to) delay(20) }
    }

    @Test fun everyItemInEveryState() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("toolbarAudit") == "true")
        audit("caret in prose (nothing to undo)") { caretAfter(it, "alpha") }
        audit("caret in a list item") { caretAfter(it, "item") }
        audit("caret in code") { caretAfter(it, "code") }
        audit("block selected as one object") { c ->
            val at = c.view.editableText.indexOf("code")
            c.view.engine!!.selectCodeBlock(at)
            withTimeout(5_000) { while (c.view.selectedCodeBlock == null) delay(20) }
        }
        audit("a block and a line outside it selected") { c ->
            val e = c.view.editableText
            selectRange(c, e.indexOf("item"), e.indexOf("code") + "code".length)
        }
        audit("image selected") { c ->
            val e = c.view.editableText
            val image = e.getSpans(0, e.length, TfImage::class.java).single()
            selectRange(c, e.getSpanStart(image), e.getSpanEnd(image))
        }
        audit("divider selected") { c ->
            val e = c.view.editableText
            val divider = e.getSpans(0, e.length, TfDivider::class.java).single()
            selectRange(c, e.getSpanStart(divider), e.getSpanEnd(divider))
        }
        audit("selection of only table lines") { c ->
            val e = c.view.editableText
            val rows = e.getSpans(0, e.length, TfTableRow::class.java)
            selectRange(c, rows.minOf { e.getSpanStart(it) }, rows.maxOf { e.getSpanEnd(it) } - 1)
        }
        audit("caret in front matter") { c ->
            Log.i("ToolbarAudit", "front matter display starts: " + c.view.editableText.take(30).toString().replace("\n", "/"))
            c.select(1)
            withTimeout(5_000) { while (c.view.selectionStart != 1) delay(20) }
        }
    }
}

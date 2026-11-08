package com.futo.notes.textfirst

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.futo.notes.localization.Localization
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** The actual note window owns the editable field's location, gestures and keyboard lifetime. */
class TextFirstTableSceneTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun aTableCellFieldSharesTheNoteWindowAndStaysOverItsCell() = compose.withTextFirstScreen(
        "Intro\n" + "above\n".repeat(30) + "\n| Name | Owner | More |\n| --- | --- | --- |\n| one | two | three |\n|  |  | tail |\n\nAfter " + "words ".repeat(20) + "\n",
        nativeTheme = tableSceneTheme,
    ) { view, _ ->
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        compose.runOnUiThread {
            val header = view.text.toString().indexOf("Name")
            view.revealRange(header, header)
        }
        compose.waitForIdle()
        val before = view.text.toString()
        scene.tap(scene.pointAt("Name", 0))
        compose.waitUntil(10_000) {
            compose.onAllNodes(isDialog()).fetchSemanticsNodes().isNotEmpty() || scene.field() != null
        }
        assertTrue("a table cell is edited in place in the note, not in a dialog",
            compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty())
        compose.waitUntil(10_000) { scene.field()?.let { it.isLaidOut && it.width > 0 && it.height > 0 && it.isFocused } == true }
        scene.assertPlacement("Name")
        val originalField = checkNotNull(scene.field())
        fun cellKey(expected: String, column: Int, shift: Boolean = false, code: Int = android.view.KeyEvent.KEYCODE_TAB) {
            val connection = scene.connection()
            connection.handler!!.post {
                val down = android.view.KeyEvent(0, 0, android.view.KeyEvent.ACTION_DOWN, code, 0,
                    if (shift) android.view.KeyEvent.META_SHIFT_ON else 0)
                connection.sendKeyEvent(down)
                connection.sendKeyEvent(android.view.KeyEvent.changeAction(down, android.view.KeyEvent.ACTION_UP))
            }
            compose.waitUntil(10_000) { scene.field()?.let { it.text.toString() == expected && it.placementTarget(view)?.column == column } == true }
            compose.waitForIdle()
            compose.runOnUiThread {
                assertSame("navigation retains the focused field", originalField, scene.fieldInWindow())
            }
            scene.assertPlacement(expected)
        }
        cellKey("Owner", 1)
        cellKey("More", 2)
        compose.waitUntil(10_000) { scene.keyboardVisible() && scene.keyboardIdle() }
        var withKeyboard = 0
        compose.runOnUiThread {
            withKeyboard = view.height
            originalField.context.getSystemService(android.view.inputmethod.InputMethodManager::class.java)
                .hideSoftInputFromWindow(originalField.windowToken, 0)
        }
        compose.waitUntil(10_000) { view.height > withKeyboard && scene.keyboardIdle() }
        compose.runOnUiThread {
            val line = view.layout.getLineForOffset(view.text.toString().indexOf("Name"))
            view.scrollTo(0, view.layout.getLineBottom(line) + view.totalPaddingTop - view.height + 8)
            assertFalse("system keyboard dismissal clears native focus", originalField.isFocused)
        }
        compose.waitForIdle()
        scene.tap(scene.pointAt("Name", 2))
        compose.waitUntil(10_000) { originalField.isFocused && view.height <= withKeyboard && scene.keyboardIdle() }
        compose.waitForIdle()
        scene.assertPlacement("More")
        val panStart = scene.pointAt("Name", 1)
        scene.drag(panStart, panStart.first + 200 * view.resources.displayMetrics.density to panStart.second)
        compose.runOnUiThread {
            val rows = view.editableText.getSpans(0, view.length(), TfTableRow::class.java)
            assertTrue("all rows keep their shared pan", rows.all { it.scroll === rows.first().scroll })
            assertEquals("the drag pans back to the first column", 0f, rows.first().scroll.x)
            assertSame("a table drag keeps cell editing open", originalField, scene.fieldInWindow())
        }
        cellKey("three", 2, code = android.view.KeyEvent.KEYCODE_ENTER)
        cellKey("tail", 2, code = android.view.KeyEvent.KEYCODE_ENTER)
        cellKey("", 1, shift = true)
        cellKey("", 0, shift = true)
        cellKey("", 1)
        cellKey("", 0, shift = true)
        for ((column, label) in listOf(2 to "three", 1 to "two", 0 to "one", 2 to "More", 1 to "Owner", 0 to "Name")) cellKey(label, column, shift = true)
        assertEquals("navigation changes no note text", before, view.text.toString())
        scene.tap(scene.pointAt("After"))
        compose.waitUntil(10_000) { scene.field() == null && view.isFocused }
        assertTrue("an outside note tap retains the keyboard", scene.keyboardVisible())
        assertEquals("leaving a cell changes no note text", before, view.text.toString())
        scene.tap(scene.pointAt("Name", 0))
        compose.waitUntil(10_000) { scene.field() != null }
        val done = Localization.fromGeneratedCatalogs(listOf("en"), "en-US").localizedText("common.actions.done")
        compose.onNodeWithText(done).performClick()
        compose.waitUntil(10_000) { scene.field() == null }
        assertEquals("Done changes no note text", before, view.text.toString())
    }

    @Test
    fun aWrappedCellKeepsItsNativeCaretInsideThePaintedRow() = compose.withTextFirstScreen(
        "Intro\n" + "above\n".repeat(30) + "\n| " + "natural words ".repeat(7).trimEnd() + " | next |\n| - | - |\n| body | tail |\n\nAfter\n",
        nativeTheme = tableSceneTheme,
    ) { view, _ ->
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        compose.runOnUiThread {
            val at = view.text.toString().indexOf("natural")
            view.revealRange(at, at)
        }
        scene.tap(scene.pointAt("natural", 0))
        compose.waitUntil(10_000) { scene.field()?.let { it.isLaidOut && it.isFocused } == true }
        scene.assertWrapped()
        val label = "natural words ".repeat(7).trimEnd()
        scene.assertPlacement(label)
        val before = view.text.toString()
        val connection = scene.connection()
        val finishFrameCheck = scene.watchPlacementFrames()
        connection.handler!!.post { connection.setSelection(label.length, label.length); connection.commitText(" ending", 1) }
        compose.waitUntil(10_000) { scene.field()?.text.toString() == label + " ending" }
        compose.waitForIdle()
        scene.assertPlacement(label + " ending")
        scene.assertCaretVisible()
        compose.runOnUiThread { view.engine!!.undo() }
        compose.waitUntil(10_000) { scene.field()?.text.toString() == label }
        assertEquals(before, view.text.toString())
        compose.runOnUiThread { view.engine!!.redo() }
        compose.waitUntil(10_000) { scene.field()?.text.toString() == label + " ending" }
        assertEquals(before.replaceFirst(label, label + " ending"), view.text.toString())
        compose.waitForIdle()
        scene.assertCaretVisible()
        finishFrameCheck()
    }
    @Test
    fun doneClosesTheFocusedCellAndItsKeyboard() = compose.withTextFirstScreen(
        "| Name | Owner |\n| - | - |\n| one | two |\n\n" + "ordinary note text ".repeat(10) + "\n",
        nativeTheme = tableSceneTheme,
    ) { view, _ ->
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        compose.runOnUiThread { view.revealRange(0, 0) }
        scene.tap(scene.pointAt("Name", 0))
        compose.waitUntil(10_000) { scene.field()?.isFocused == true && scene.keyboardVisible() }
        val before = view.text.toString()
        val done = Localization.fromGeneratedCatalogs(listOf("en"), "en-US").localizedText("common.actions.done")
        compose.onNodeWithText(done).performClick()
        compose.waitUntil(10_000) { scene.field() == null }
        compose.waitUntil(10_000) { !scene.keyboardVisible() }
        assertEquals("Done preserves note text", before, view.text.toString())
    }

    @Test
    fun aHeightOnlyFindBarChangeKeepsTheTablesHorizontalPan() = compose.withTextFirstScreen(
        "| Name | Owner | More |\n| - | - | - |\n| one | two | three |\n\n" + "ordinary note text ".repeat(10) + "\n",
        nativeTheme = tableSceneTheme,
    ) { view, _ ->
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        compose.runOnUiThread { view.revealRange(0, 0) }
        scene.tap(scene.pointAt("Name", 0))
        compose.waitUntil(10_000) { scene.field()?.isFocused == true && scene.keyboardVisible() && scene.keyboardIdle() }
        val field = checkNotNull(scene.field())
        val connection = scene.connection()
        connection.handler!!.post {
            repeat(2) {
                val down = android.view.KeyEvent(0, 0, android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_TAB, 0)
                connection.sendKeyEvent(down)
                connection.sendKeyEvent(android.view.KeyEvent.changeAction(down, android.view.KeyEvent.ACTION_UP))
            }
        }
        compose.waitUntil(10_000) { field.placementTarget(view)?.column == 2 }
        compose.waitForIdle()
        var height = 0
        compose.runOnUiThread {
            val row = view.editableText.getSpans(0, view.length(), TfTableRow::class.java).first()
            row.scrollBy(-row.scroll.x)
            view.redrawTableRows()
            height = view.height
        }
        val strings = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
        compose.onNodeWithContentDescription(strings.localizedText("notes.actions.moreAccessibilityLabel")).performClick()
        compose.onNodeWithText(strings.localizedText("editor.find.open")).performClick()
        compose.waitUntil(10_000) { view.height != height && scene.keyboardIdle() }
        compose.waitForIdle()
        compose.runOnUiThread {
            assertSame("opening Find keeps the existing cell editor", field, scene.fieldInWindow())
            val row = view.editableText.getSpans(0, view.length(), TfTableRow::class.java).first()
            assertEquals("a height-only viewport change must not undo the reader's horizontal pan", 0f, row.scroll.x)
        }
    }

    @Test
    fun openingACellTransfersTheAlreadyVisibleNoteKeyboard() = compose.withTextFirstScreen(
        "| Name | Owner |\n| - | - |\n| one | two |\n\n" + "ordinary note text ".repeat(10) + "\n",
        nativeTheme = tableSceneTheme,
    ) { view, _ ->
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        compose.runOnUiThread { view.revealRange(0, 0) }
        scene.tap(scene.pointAt("ordinary"))
        compose.waitUntil(10_000) { view.isFocused && scene.keyboardVisible() && scene.keyboardIdle() }
        val before = view.text.toString()
        scene.tap(scene.pointAt("Name", 0))
        compose.waitUntil(10_000) { scene.field()?.isFocused == true && scene.keyboardVisible() && scene.keyboardIdle() }
        assertFalse("cell input replaces note input focus", view.isFocused)
        scene.assertPlacement("Name")
        assertEquals(before, view.text.toString())
    }

    @Test
    fun findPaintsCurrentAndOtherMatchesAboveTheActiveCell() = compose.withTextFirstScreen(
        "| 🧑‍💻 Name natural words across several lines Name | Owner |\n| - | - |\n| body | tail |\n\n" + "ordinary note text ".repeat(10) + "\n",
        nativeTheme = tableSceneTheme,
    ) { view, _ ->
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        compose.runOnUiThread { view.revealRange(0, 0) }
        scene.tap(scene.pointAt("Name", 0))
        compose.waitUntil(10_000) { scene.field()?.isFocused == true && scene.keyboardVisible() && scene.keyboardIdle() }
        val before = view.text.toString()
        val strings = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
        compose.onNodeWithContentDescription(strings.localizedText("notes.actions.moreAccessibilityLabel")).performClick()
        compose.onNodeWithText(strings.localizedText("editor.find.open")).performClick()
        compose.waitUntil(10_000) { scene.queryFocused() && scene.keyboardVisible() && scene.keyboardIdle() }
        val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        instrumentation.sendStringSync("Name")
        val seq = view.appliedSeq
        instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_ENTER)
        compose.waitUntil(10_000) { view.appliedSeq > seq }
        compose.waitForIdle()
        compose.runOnUiThread {
            val field = checkNotNull(scene.fieldInWindow())
            assertTrue("Find marks follow the wrapped native layout", field.layout.lineCount > 1)
            assertEquals("the match starts after the complete Unicode prefix", field.text.toString().indexOf("Name"), field.selectionStart)
        }
        scene.assertFindPaint(current = true, other = true)
        compose.onNodeWithContentDescription(strings.localizedText("editor.find.close")).performClick()
        compose.waitUntil(10_000) { !scene.queryFocused() && !scene.keyboardVisible() }
        compose.waitForIdle()
        scene.assertFindPaint(current = false, other = false)
        assertEquals("painting Find changes no note text", before, view.text.toString())
    }

    @Test fun closingPlainNoteFindDismissesTheQueryKeyboard() = findCloseKeyboard(cell = false)
    @Test fun closingCellFindDismissesTheQueryKeyboard() = findCloseKeyboard(cell = true)
    @Test fun closingFindKeepsTheCellsOwnKeyboard() = findCloseKeyboard(cell = true, cellFocus = true)

    private fun findCloseKeyboard(cell: Boolean, cellFocus: Boolean = false) = compose.withTextFirstScreen(
        (if (cell) "| Name | Owner |\n| - | - |\n| one | two |\n\n" else "") + "ordinary note text ".repeat(10) + "\n",
        nativeTheme = tableSceneTheme,
    ) { view, _ ->
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        if (cell) {
            compose.runOnUiThread { view.revealRange(0, 0) }
            scene.tap(scene.pointAt("Name", 0))
            compose.waitUntil(10_000) { scene.field()?.isFocused == true && scene.keyboardVisible() && scene.keyboardIdle() }
        }
        val strings = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
        compose.onNodeWithContentDescription(strings.localizedText("notes.actions.moreAccessibilityLabel")).performClick()
        compose.onNodeWithText(strings.localizedText("editor.find.open")).performClick()
        compose.waitUntil(10_000) { scene.queryFocused() && scene.keyboardVisible() && scene.keyboardIdle() }
        val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        instrumentation.sendStringSync(if (cell) "Name" else "ordinary")
        val beforeStep = view.appliedSeq
        instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_ENTER)
        compose.waitUntil(10_000) { view.appliedSeq > beforeStep }
        if (cellFocus) {
            scene.tap(scene.pointAt("Name", 0))
            compose.waitUntil(10_000) { scene.field()?.isFocused == true && scene.keyboardVisible() && scene.keyboardIdle() }
        }
        val before = view.text.toString()
        val selection = view.selectionStart to view.selectionEnd
        compose.onNodeWithContentDescription(strings.localizedText("editor.find.close")).performClick()
        if (cellFocus) compose.waitUntil(10_000) { scene.field()?.isFocused == true && scene.keyboardVisible() && scene.keyboardIdle() }
        else compose.waitUntil(10_000) { !scene.queryFocused() && !scene.keyboardVisible() }
        assertEquals("Find close preserves note text", before, view.text.toString())
        assertEquals("Find close preserves the selection", selection, view.selectionStart to view.selectionEnd)
    }
}

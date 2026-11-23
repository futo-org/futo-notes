package com.futo.notes.textfirst

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** The open cell's row: a pan from either edge of the note is the table's, and both grips go once the cell is out of view. */
class TextFirstTableEdgePanTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    /** A pan from the note's margin over the open row belongs to the table, not to the part of the field the table has scrolled out of view. */
    @Test
    fun aPanFromTheNoteMarginOverTheOpenRowPansTheTableNotTheClippedField() = compose.withTextFirstScreen(
        "| a1 | b1 | c1 | d1 | e1 | f1 |\n| - | - | - | - | - | - |\n| a2 | b2 | c2 | d2 | e2 | f2 |\n\n" + "ordinary note text ".repeat(10) + "\n",
        nativeTheme = tableSceneTheme,
    ) { view, _ ->
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        compose.runOnUiThread { view.revealRange(0, 0) }
        scene.tap(scene.pointAt("a2", 0))
        compose.waitUntil(10_000) { scene.field()?.isFocused == true && scene.keyboardIdle() }
        var before = 0f
        var from = 0f to 0f
        compose.runOnUiThread {
            val row = view.editableText.getSpans(0, view.length(), TfTableRow::class.java).last { !it.row.header }
            row.scrollBy(view.style.dp(60f))
            view.redrawTableRows()
        }
        compose.waitUntil(10_000) { readOnMainThread { scene.fieldInWindow()?.clipBounds != null } }
        compose.waitForIdle()
        compose.runOnUiThread {
            val row = view.editableText.getSpans(0, view.length(), TfTableRow::class.java).last { !it.row.header }
            before = row.scroll.x
            val note = IntArray(2).also(view::getLocationOnScreen)
            val field = checkNotNull(scene.fieldInWindow())
            from = note[0] + 3f to field.let { IntArray(2).also(it::getLocationOnScreen)[1] + it.height / 2f }
        }
        scene.drag(from, from.first + view.style.dp(90f) to from.second, overClippedField = true)
        compose.waitForIdle()
        compose.runOnUiThread {
            val row = view.editableText.getSpans(0, view.length(), TfTableRow::class.java).last { !it.row.header }
            assertTrue("the pan scrolled the table right ($before -> ${row.scroll.x})", row.scroll.x < before)
        }
    }

    /** The same at the right edge: the part of the open field past the table's visible right edge is not the field's to take. */
    @Test
    fun aPanFromTheRightMarginOverTheOpenRowPansTheTableNotTheClippedField() = compose.withTextFirstScreen(
        "| a1 | b1 | c1 | d1 | e1 | f1 |\n| - | - | - | - | - | - |\n| a2 | b2 | c2 | d2 | e2 | f2 |\n\n" + "ordinary note text ".repeat(10) + "\n",
        nativeTheme = tableSceneTheme,
    ) { view, _ ->
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        compose.runOnUiThread { view.revealRange(0, 0) }
        scene.tap(scene.pointAt("c2", 2))
        compose.waitUntil(10_000) { scene.field()?.isFocused == true && scene.keyboardIdle() }
        // Tab to the fourth column, which the table scrolls to show; scrolled back, that cell is part-clipped at the right.
        val connection = scene.connection()
        connection.handler!!.post {
            val down = android.view.KeyEvent(0, 0, android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_TAB, 0)
            connection.sendKeyEvent(down)
            connection.sendKeyEvent(android.view.KeyEvent.changeAction(down, android.view.KeyEvent.ACTION_UP))
        }
        compose.waitUntil(10_000) { scene.field()?.text?.toString() == "d2" }
        compose.waitForIdle()
        compose.runOnUiThread {
            val row = view.editableText.getSpans(0, view.length(), TfTableRow::class.java).last { !it.row.header }
            row.scrollBy(-row.scroll.x)
            view.redrawTableRows()
        }
        compose.waitUntil(10_000) { readOnMainThread { scene.fieldInWindow()?.clipBounds != null } }
        compose.waitForIdle()
        var before = 0f
        var from = 0f to 0f
        compose.runOnUiThread {
            val row = view.editableText.getSpans(0, view.length(), TfTableRow::class.java).last { !it.row.header }
            before = row.scroll.x
            val note = IntArray(2).also(view::getLocationOnScreen)
            val field = checkNotNull(scene.fieldInWindow())
            from = note[0] + view.width - 3f to IntArray(2).also(field::getLocationOnScreen)[1] + field.height / 2f
        }
        scene.drag(from, from.first - view.style.dp(90f) to from.second, overClippedField = true)
        compose.waitForIdle()
        compose.runOnUiThread {
            val row = view.editableText.getSpans(0, view.length(), TfTableRow::class.java).last { !it.row.header }
            assertTrue("the pan scrolled the table left ($before -> ${row.scroll.x})", row.scroll.x > before)
        }
    }

    /** Both grips go while less than 20 dp of the open cell is in view: scrolled away vertically, the header's column grip too. */
    @Test
    fun theGripsGoWhenTheNoteScrollsTheOpenCellOutOfView() = compose.withTextFirstScreen(
        "| h1 | h2 |\n| - | - |\n" + (1..40).joinToString("") { "| r$it | s$it |\n" } + "\n" + "ordinary note text ".repeat(10) + "\n",
        nativeTheme = tableSceneTheme,
    ) { view, _ ->
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        compose.runOnUiThread { val at = view.text.toString().indexOf("r30 "); view.revealRange(at, at) }
        compose.waitForIdle()
        scene.tap(scene.pointAt("r30 ", 0))
        compose.waitUntil(10_000) { scene.field()?.isFocused == true && scene.keyboardIdle() }
        fun grips(root: android.view.View): List<TableGripView> = when (root) {
            is TableGripView -> listOf(root)
            is android.view.ViewGroup -> (0 until root.childCount).flatMap { grips(root.getChildAt(it)) }
            else -> emptyList()
        }
        fun showing() = readOnMainThread { grips(compose.activity.window.decorView).count { it.visibility == android.view.View.VISIBLE } }
        compose.waitUntil(10_000) { showing() == 2 }
        // The reader's own swipes, down the note, until its top shows.
        val shown = readOnMainThread { android.graphics.Rect().also { view.getGlobalVisibleRect(it) } }
        repeat(20) {
            if (readOnMainThread { view.scrollY } > 0) scene.drag(shown.centerX().toFloat() to shown.top + 40f, shown.centerX().toFloat() to shown.bottom - 40f)
        }
        compose.waitForIdle()
        Thread.sleep(500)
        assertEquals("the open cell is far below the view", true, readOnMainThread {
            scene.fieldInWindow()!!.let { it.top > view.height }
        }.also { if (!it) throw AssertionError(readOnMainThread { "scrollY=${view.scrollY} fieldTop=${scene.fieldInWindow()?.top} h=${view.height} alpha=${scene.fieldInWindow()?.alpha}" }) })
        assertEquals("no grip is left on screen for a cell that is not", 0, showing())
    }
}

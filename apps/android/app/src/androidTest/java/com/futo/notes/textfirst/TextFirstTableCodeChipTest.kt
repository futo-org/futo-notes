package com.futo.notes.textfirst

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Inline code in the open cell's field is drawn on the same chip as in the closed grid and a paragraph. */
class TextFirstTableCodeChipTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun inlineCodeInTheOpenFieldIsDrawnOnTheChip() = compose.withTextFirstScreen(
        "| h1 | h2 |\n| - | - |\n| `code` | plain |\n\n" + "ordinary note text ".repeat(10) + "\n",
        nativeTheme = tableSceneTheme,
    ) { view, _ ->
        val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
        compose.runOnUiThread { view.revealRange(0, 0) }
        scene.tap(scene.pointAt("code", 0))
        compose.waitUntil(10_000) { scene.field()?.isFocused == true && scene.keyboardIdle() }
        compose.waitForIdle()
        compose.runOnUiThread {
            val field = checkNotNull(scene.fieldInWindow())
            assertEquals("code", field.text.toString())
            val bitmap = android.graphics.Bitmap.createBitmap(field.width, field.height, android.graphics.Bitmap.Config.ARGB_8888)
            field.draw(android.graphics.Canvas(bitmap))
            val y = field.height / 2
            val beforeTheLetters = bitmap.getPixel((view.style.dp(10f) - view.style.textSizePx * 0.1f).toInt(), y)
            val blank = bitmap.getPixel(field.width - view.style.dp(8f).toInt(), y)
            assertNotEquals("The chip shows left of the code, where the field is otherwise blank", blank, beforeTheLetters)
        }
    }
}

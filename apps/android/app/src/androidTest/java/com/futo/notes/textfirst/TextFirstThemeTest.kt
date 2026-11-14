package com.futo.notes.textfirst

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.futo.notes.ui.theme.FutoColors
import com.futo.notes.ui.theme.FutoPalette
import com.futo.notes.ui.theme.darkFutoColors
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class TextFirstThemeTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun themeChangesRecolorTheOpenNoteAndCellWithoutReplacingTheSession() {
        val dark = mutableStateOf(false)
        compose.withTextFirstScreen(
            "plain text ".repeat(20) + "\n\n| Name | Value |\n| --- | --- |\n| one | two |\n",
            nativeTheme = tableSceneTheme,
            darkTheme = { dark.value },
        ) { view, _ ->
            val scene = TableCellScene(view, compose.activity) { action -> compose.runOnUiThread(action) }
            compose.runOnUiThread {
                val at = view.text.toString().indexOf("Name")
                view.revealRange(at, at)
            }
            scene.tap(scene.pointAt("Name", 0))
            compose.waitUntil(10_000) { scene.field()?.isFocused == true }
            val field = checkNotNull(scene.field())
            val engine = view.engine
            val text = view.text.toString()
            val selection = view.selectionStart to view.selectionEnd
            val cellSelection = field.selectionStart to field.selectionEnd
            for (isDark in listOf(true, false)) {
                compose.runOnUiThread { dark.value = isDark }
                compose.waitForIdle()
                compose.runOnUiThread {
                    val colors = if (isDark) darkFutoColors else FutoColors()
                    assertEquals(colors.textPrimary.toArgb(), view.currentTextColor)
                    assertEquals(colors.textPrimary.toArgb(), field.currentTextColor)
                    assertEquals(colors.textPrimary.toArgb(), view.style.textColor)
                    assertEquals(colors.textMuted.toArgb(), view.style.mutedColor)
                    assertEquals(colors.accent.toArgb(), view.style.linkColor)
                    assertEquals(colors.border.toArgb(), view.style.borderColor)
                    assertEquals(colors.surfaceSunken.toArgb(), view.style.surfaceColor)
                    assertEquals((if (isDark) FutoPalette.InkHairline else FutoPalette.N200).toArgb(), view.style.codeBackground)
                    assertSame("the open engine survives a theme change", engine, view.engine)
                    assertSame("the active cell survives a theme change", field, scene.fieldInWindow())
                    assertEquals(text, view.text.toString())
                    assertEquals(selection, view.selectionStart to view.selectionEnd)
                    assertEquals(cellSelection, field.selectionStart to field.selectionEnd)
                }
            }
        }
    }
}

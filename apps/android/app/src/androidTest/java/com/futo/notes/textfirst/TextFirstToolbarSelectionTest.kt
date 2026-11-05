package com.futo.notes.textfirst

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performClick
import androidx.compose.ui.viewinterop.AndroidView
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.ui.theme.FutoNotesTheme
import com.futo.notes.ui.theme.FutoTheme
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import uniffi.futo_notes_ffi.NoteStore

/** Native selection callbacks → engine query → the real keyboard toolbar, including slot recreation. */
class TextFirstToolbarSelectionTest {
    @get:Rule val compose = createAndroidComposeRule<TextFirstToolbarTestActivity>()

    @Test fun selectingFormattedWordsLightsTheirButtonsAfterTheToolbarReopens() = exercise {
        for ((word, key, id) in listOf(
            Triple("bold", "bold", "bold"),
            Triple("italic", "italic", "italic"),
            Triple("strike", "strikethrough", "strikethrough"),
        )) {
            selectInView(word)
            compose.waitUntil(5_000) { id in toolbarActive(controller.caret) }
            assertActive(key)
            reopenToolbar()
            assertActive(key)
        }
        selectInView("plain")
        compose.waitUntil(5_000) { "bold" !in toolbarActive(controller.caret) && "italic" !in toolbarActive(controller.caret) && "strikethrough" !in toolbarActive(controller.caret) }
        assertEquals(emptySet<String>(), toolbarActive(controller.caret).intersect(setOf("bold", "italic", "strikethrough")))
    }

    @Test fun selectingAnOrderedListLightsItsToolbarButtonAfterReopening() = exercise {
        selectInView("numbered")
        compose.waitUntil(5_000) { "ordered-list" in toolbarActive(controller.caret) }
        assertActive("orderedList")
        reopenToolbar()
        assertActive("orderedList")
    }

    private inner class Rig(val controller: TextFirstController, val localization: Localization, val accent: Color) {
        fun label(key: String) = localization.localizedText("editor.toolbar.$key")
        fun selectInView(word: String) {
            compose.runOnUiThread {
                val start = controller.view.editableText.toString().indexOf(word).also { check(it >= 0) }
                // Exercise the platform selection listener; hostSelect would bypass the reported path.
                controller.view.setSelection(start, start + word.length)
            }
        }
        fun reopenToolbar() {
            compose.onNodeWithContentDescription(label("dismissKeyboard")).performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription(label("bold")).fetchSemanticsNodes().isEmpty() }
            compose.runOnUiThread { controller.view.showKeyboard() }
            compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription(label("bold")).fetchSemanticsNodes().isNotEmpty() }
        }
        fun assertActive(key: String) {
            val node = compose.onNodeWithContentDescription(label(key))
            node.performScrollTo()
            val pixels = node.captureToImage().toPixelMap()
            var accentPixels = 0
            for (y in 0 until pixels.height) for (x in 0 until pixels.width) {
                val color = pixels[x, y]
                if (kotlin.math.abs(color.red - accent.red) < 0.02f &&
                    kotlin.math.abs(color.green - accent.green) < 0.02f &&
                    kotlin.math.abs(color.blue - accent.blue) < 0.02f) accentPixels++
            }
            assertTrue("$key toolbar icon uses the active accent", accentPixels > 0)
        }
    }

    private fun exercise(check: Rig.() -> Unit) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "toolbar-selection-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val store = NoteStore(root.path)
        val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
        lateinit var controller: TextFirstController
        var accent = Color.Unspecified
        try {
            store.createNote("n", "", "prefix **bold** *italic* ~~strike~~ plain\n\n1. numbered\n2. next\n")
            compose.runOnUiThread { controller = createTextFirstController(compose.activity, { store }, root) }
            compose.setContent {
                FutoNotesTheme(darkTheme = false) {
                    CompositionLocalProvider(LocalLocalization provides localization) {
                        accent = FutoTheme.colors.accent
                        Scaffold(containerColor = FutoTheme.colors.surface) { padding ->
                            Column(Modifier.padding(padding).consumeWindowInsets(padding).fillMaxSize().imePadding()) {
                                AndroidView(factory = { controller.view }, modifier = Modifier.weight(1f).fillMaxWidth())
                                TextFirstToolbarSlot(controller, onPickImage = {})
                            }
                        }
                    }
                }
            }
            compose.runOnUiThread { controller.open("n") }
            compose.waitUntil(10_000) { controller.opened }
            val firstFrame = CompletableDeferred<Unit>()
            compose.runOnUiThread {
                controller.view.onRenderFrame = {
                    controller.view.onRenderFrame = null
                    firstFrame.complete(Unit)
                }
                controller.view.invalidate()
            }
            compose.waitUntil(10_000) {
                firstFrame.isCompleted && controller.view.hasWindowFocus() && controller.view.width > 0 && controller.view.height > 0
            }
            compose.runOnUiThread {
                controller.view.isFocusableInTouchMode = true
                controller.view.showKeyboard()
            }
            compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription(localization.localizedText("editor.toolbar.bold")).fetchSemanticsNodes().isNotEmpty() }
            Rig(controller, localization, accent).check()
        } finally {
            runBlocking { controller.discard() }
            compose.runOnUiThread { controller.dispose() }
            store.destroy()
            root.deleteRecursively()
        }
    }
}

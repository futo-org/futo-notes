package com.futo.notes.textfirst

import android.graphics.Color
import android.view.inputmethod.EditorInfo
import androidx.activity.ComponentActivity
import androidx.core.content.res.ResourcesCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.R
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.NoteStore

/** Native controller + real engine/store seam for the toolbar link dialog. */
class TextFirstLinkTest {
    @Test
    fun inspectExistingLinkDoesNotEditAndUnlinkPreservesLabelAndUndo() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "links-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        val source = "before [café](https://old.test) after"
        try {
            store.createNote("links", "", source)
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("links") { assertNull(it); done.resume(Unit) }
                    }
                }
                controller.select(9)
                val link = controller.linkDraft()
                assertNotNull("Toolbar Link must inspect the attached engine selection", link)
                assertEquals("café", link!!.label)
                assertEquals("https://old.test", link.destination)
                assertTrue(link.existing)
                assertEquals(source, controller.sourceText()) // Cancel is no command.
                assertTrue(controller.removeLink(link))
                assertEquals("before café after", controller.sourceText())
                controller.undo()
                assertEquals(source, controller.sourceText())
                assertNotNull(controller.close())
                controller.open("links")
                assertEquals(source, controller.sourceText())
                assertNotNull(controller.close())
            }
        } finally {
            withContext(Dispatchers.Main) { controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    @Test
    fun insertAndChangeLabelAndDestinationAreEachOneUndoAndPersistOnReopen() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "link-edit-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        val source = "before word after"
        try {
            store.createNote("links", "", source)
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("links") { assertNull(it); done.resume(Unit) }
                    }
                }
                controller.select(7, 11)
                val insertion = controller.linkDraft()!!
                assertFalse(insertion.existing)
                assertEquals("word", insertion.label)
                assertTrue(controller.editLink(insertion, "FUTO", "https://futo.org"))
                assertEquals("before [FUTO](https://futo.org) after", controller.sourceText())
                controller.undo()
                assertEquals(source, controller.sourceText())
                controller.redo()
                controller.select(8)
                val existing = controller.linkDraft()!!
                assertTrue(controller.editLink(existing, "café", "https://next.test"))
                assertEquals("before [café](https://next.test) after", controller.sourceText())
                controller.undo()
                assertEquals("before [FUTO](https://futo.org) after", controller.sourceText())
                controller.redo()
                assertNotNull(controller.close())
                controller.open("links")
                assertEquals("before [café](https://next.test) after", controller.sourceText())
                assertFalse("draft claims cannot edit a reopened attachment", controller.editLink(existing, "wrong", "https://wrong.test"))
                assertNotNull(controller.close())
            }
        } finally {
            withContext(Dispatchers.Main) { controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    private fun createController(activity: ComponentActivity, core: () -> NoteStore, root: File): TextFirstController {
        val metrics = activity.resources.displayMetrics
        val regular = ResourcesCompat.getFont(activity, R.font.barlow_regular)!!
        return TextFirstController(activity, core, root, TextFirstStyle(
            metrics.density, 17f * metrics.scaledDensity, regular,
            ResourcesCompat.getFont(activity, R.font.barlow_semibold)!!,
            ResourcesCompat.getFont(activity, R.font.barlow_bold)!!,
            ResourcesCompat.getFont(activity, R.font.jetbrains_mono_regular)!!,
            Color.BLACK, Color.GRAY, Color.BLUE, Color.GRAY, Color.WHITE, Color.WHITE,
        ))
    }

}

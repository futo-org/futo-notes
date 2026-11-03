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

/** Native input/controller + canonical completion, through the real store. */
class TextFirstCompletionTest {
    @Test
    fun unicodeCompletionAcceptsOneEditAndRejectsStaleClaims() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "completion-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        val source = "before [[東 after"
        try {
            store.createNote("links", "", source)
            store.createNote("東京", "work", "destination")
            store.createNote("other", "", "other")
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createController(activity, { store }, root)
                        activity.setContentView(controller.view)
                        controller.open("links") { assertNull(it); done.resume(Unit) }
                    }
                }
                controller.select(10)
                val completion = controller.completionDraft()!!
                assertEquals(listOf("work/東京"), completion.value.candidates.map { it.noteId })
                assertEquals("東京", completion.value.candidates.single().label)
                assertTrue(controller.acceptCompletion(completion, "work/東京"))
                assertEquals("before [[work/東京]] after", controller.sourceText())
                controller.undo()
                assertEquals(source, controller.sourceText())
                controller.select(10)
                val stale = controller.completionDraft()!!
                controller.select(0)
                assertFalse(controller.acceptCompletion(stale, "work/東京"))
                assertEquals(source, controller.sourceText())
                assertNotNull(controller.close())
            }
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
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

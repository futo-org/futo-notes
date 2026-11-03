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

/** Real native input and the public controller leave boundary, backed by the real Store. */
class TextFirstLeaveTest {
    @Test
    fun failedLeaveRetainsEditableDraftAndRetrySavesLatestText() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "leave-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        var initialized = false
        try {
            store.createNote("draft", "", "base")
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        val metrics = activity.resources.displayMetrics
                        val regular = ResourcesCompat.getFont(activity, R.font.barlow_regular)!!
                        controller = TextFirstController(activity, { store }, root, TextFirstStyle(
                            metrics.density, 17f * metrics.scaledDensity, regular,
                            ResourcesCompat.getFont(activity, R.font.barlow_semibold)!!,
                            ResourcesCompat.getFont(activity, R.font.barlow_bold)!!,
                            ResourcesCompat.getFont(activity, R.font.jetbrains_mono_regular)!!,
                            Color.BLACK, Color.GRAY, Color.BLUE, Color.GRAY, Color.WHITE, Color.WHITE,
                        ))
                        initialized = true
                        activity.setContentView(controller.view)
                        controller.open("draft") { assertNull(it); done.resume(Unit) }
                    }
                }
            }
            val note = File(root, "draft.md")
            check(note.delete())
            check(note.mkdir()) // deterministic save/read failure in this test's own vault
            suspend fun type(text: String) {
                withContext(Dispatchers.Main) {
                    val connection = controller.view.onCreateInputConnection(EditorInfo())!!
                    suspendCancellableCoroutine<Unit> { done ->
                        connection.handler!!.post { connection.commitText(text, 1); done.resume(Unit) }
                    }
                }
            }
            type("draft ")
            assertNull(withContext(Dispatchers.Main) { controller.close() })
            assertTrue("failed detach keeps the controller attached", controller.opened)
            assertEquals("draft base", withContext(Dispatchers.Main) { controller.sourceText() })
            type("latest ")
            assertEquals("draft latest base", withContext(Dispatchers.Main) { controller.sourceText() })
            check(note.delete())
            note.writeText("base")
            assertNotNull(withContext(Dispatchers.Main) { controller.close() })
            assertFalse(controller.opened)
            assertEquals("draft latest base", store.read("draft"))
        } finally {
            if (initialized) withContext(Dispatchers.Main) { controller.dispose() }
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }
}

package com.futo.notes.textfirst

import android.graphics.Color
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.activity.ComponentActivity
import androidx.core.content.res.ResourcesCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.R
import com.futo.notes.storage.StorageMigrationGate
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.junit.Assert.assertNull
import uniffi.futo_notes_ffi.NoteStore

/** The editor under test, styled like the app, for the classes that drive it through a bare activity. */
internal fun createTextFirstController(activity: ComponentActivity, core: () -> NoteStore, root: File, storageGate: StorageMigrationGate? = null): TextFirstController {
    val metrics = activity.resources.displayMetrics
    val regular = ResourcesCompat.getFont(activity, R.font.barlow_regular)!!
    return TextFirstController(activity, core, root, TextFirstStyle(
        metrics.density, 17f * metrics.scaledDensity, regular,
        ResourcesCompat.getFont(activity, R.font.barlow_semibold)!!,
        ResourcesCompat.getFont(activity, R.font.barlow_bold)!!,
        ResourcesCompat.getFont(activity, R.font.jetbrains_mono_regular)!!,
        Color.BLACK, Color.GRAY, Color.BLUE, Color.GRAY, Color.WHITE, Color.WHITE,
        italic = ResourcesCompat.getFont(activity, R.font.barlow_italic)!!,
        boldItalic = ResourcesCompat.getFont(activity, R.font.barlow_bold_italic)!!,
        semiboldItalic = ResourcesCompat.getFont(activity, R.font.barlow_semibold_italic)!!,
    ), storageGate = storageGate)
}

/**
 * Keyboard calls arrive on the connection's handler, as the system delivers
 * them; calling them on the main thread raced the posted selection and Enter
 * landed at the old caret.
 */
internal suspend fun textFirstIme(c: TextFirstController, cell: Boolean = false, connection: InputConnection? = null, call: InputConnection.() -> Unit) {
    val active = connection ?: (if (cell) c.cellView!! else c.view).onCreateInputConnection(EditorInfo())!!
    suspendCancellableCoroutine<Unit> { done ->
        active.handler!!.post { active.call(); c.view.post { done.resume(Unit) } }
    }
}

internal fun textFirstSession(raw: String, body: suspend (TextFirstController) -> Unit) = runBlocking {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = File(context.cacheDir, "exit-${UUID.randomUUID()}").apply { check(mkdirs()) }
    val scenario = ActivityScenario.launch(ComponentActivity::class.java)
    val store = NoteStore(root.path)
    lateinit var controller: TextFirstController
    try {
        store.createNote("n", "", raw)
        withContext(Dispatchers.Main) {
            suspendCancellableCoroutine<Unit> { done ->
                scenario.onActivity { activity ->
                    controller = createTextFirstController(activity, { store }, root)
                    activity.setContentView(controller.view)
                    controller.open("n") { assertNull(it); done.resume(Unit) }
                }
            }
            controller.view.requestFocus()
            delay(300L)
            body(controller)
        }
    } finally {
        withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
        scenario.close()
        store.destroy()
        root.deleteRecursively()
    }
}

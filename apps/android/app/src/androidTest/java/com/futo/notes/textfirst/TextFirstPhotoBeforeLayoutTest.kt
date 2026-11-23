package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Color
import android.view.View
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.NoteStore

/**
 * Sol (round 3): a photo asked for before the note's first layout was decoded for a width of one pixel; landing before
 * the layout it was kept, and the load at the real width then skipped the photo, drawn a pixel wide. Photos load once
 * the note has its width.
 */
class TextFirstPhotoBeforeLayoutTest {
    @Test fun aPhotoOpenedBeforeTheFirstLayoutLoadsAtTheNotesWidth() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "before-layout-${UUID.randomUUID()}").apply { check(mkdirs()) }
        File(root, "p.png").outputStream().use { Bitmap.createBitmap(1200, 600, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.CYAN) }.compress(Bitmap.CompressFormat.PNG, 100, it) }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val store = NoteStore(root.path)
        lateinit var controller: TextFirstController
        try {
            store.createNote("n", "", "![p](p.png)\n\nafter\n")
            withContext(Dispatchers.Main) {
                suspendCancellableCoroutine<Unit> { done ->
                    scenario.onActivity { activity ->
                        controller = createTextFirstController(activity, { store }, root)
                        // Not laid out yet: the note has no width while it opens and its photo loads.
                        controller.view.visibility = View.GONE
                        activity.setContentView(controller.view)
                        controller.open("n") { assertNull(it); done.resume(Unit) }
                    }
                }
            }
            delay(1_500)
            withContext(Dispatchers.Main) { controller.view.visibility = View.VISIBLE }
            withTimeout(5_000) { while (withContext(Dispatchers.Main) { controller.view.width == 0 || controller.view.editableText.getSpans(0, controller.view.length(), TfImage::class.java).firstOrNull()?.bitmap == null }) delay(20) }
            delay(800)
            val width = withContext(Dispatchers.Main) { controller.view.editableText.getSpans(0, controller.view.length(), TfImage::class.java).single().bitmap!!.width }
            assertTrue("the photo was decoded for the note's width, not one pixel ($width px)", width > 100)
        } finally {
            withContext(Dispatchers.Main) { controller.discard(); controller.dispose() }
            scenario.close(); store.destroy(); root.deleteRecursively()
        }
    }
}

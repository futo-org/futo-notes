package com.futo.notes.textfirst

import android.graphics.Color
import android.graphics.Bitmap
import android.graphics.Typeface
import android.text.Editable
import android.text.TextWatcher
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.NotesStore
import java.io.File
import java.util.UUID
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Real session + native view callbacks + the migration-safe attachment workflow. */
class TextFirstImageAttachmentTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun cancellationAfterAcceptedImageKeepsItsAttachment() = exercise(attached = false)

    @Test fun insertionInLaidOutEditorDisplacesFollowingText() = exercise(attached = true)

    @Test fun oldClaimCannotInsertIntoAnotherNoteAndCleansItsFile() = exercise(attached = false, retired = true)

    private fun exercise(attached: Boolean, retired: Boolean = false) = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scratch = File(context.cacheDir, "image-ack-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val root = File(scratch, "notes").apply { check(mkdirs()) }
        File(root, "origin.md").writeText("before")
        File(root, "other.md").writeText("other unchanged")
        lateinit var store: NotesStore
        lateinit var controller: TextFirstController
        compose.runOnUiThread { store = NotesStore(root, File(scratch, "index")) }
        compose.waitUntil(15_000) { store.hasBootstrapped }
        val opened = CompletableDeferred<Throwable?>()
        withContext(Dispatchers.Main) {
            val f = Typeface.DEFAULT
            controller = TextFirstController(compose.activity, { store.core }, root,
                TextFirstStyle(1f, 17f, f, f, f, f, Color.BLACK, Color.GRAY, Color.BLUE,
                    Color.GRAY, Color.WHITE, Color.WHITE), store)
            if (attached) compose.activity.setContentView(controller.view)
            controller.open("origin") { opened.complete(it) }
        }
        assertNull(opened.await())
        try {
            val claim = withContext(Dispatchers.Main) { checkNotNull(controller.imageClaim()) }
            if (retired) withContext(Dispatchers.Main) {
                assertNotNull(controller.close())
                val otherOpened = CompletableDeferred<Throwable?>()
                controller.open("other") { otherOpened.complete(it) }
                assertNull(otherOpened.await())
            }
            lateinit var insertion: Job
            withContext(Dispatchers.Main) {
                controller.view.addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                    override fun afterTextChanged(s: Editable?) { if (!attached && !retired) insertion.cancel() }
                })
                insertion = launch(start = CoroutineStart.LAZY) {
                    store.saveImageIntoVault(
                        save = {
                            val file = File(it, "accepted.png")
                            if (attached) {
                                // Images are never upscaled, so the photo must be at least as wide as the editor for
                                // the text after it to land below rather than beside it (a 640 px photo is narrower
                                // than a 1080 px screen); square keeps the drawn height above the 360 px checks.
                                val side = maxOf(640, context.resources.displayMetrics.widthPixels)
                                val bitmap = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
                                bitmap.eraseColor(Color.BLUE)
                                file.outputStream().use { out -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, out) }
                                bitmap.recycle()
                            } else file.writeBytes(byteArrayOf(1))
                            "accepted.png"
                        },
                        useSavedImage = { check(controller.insertImage(claim, it)) },
                    )
                }
                insertion.start()
            }
            withTimeout(10_000) { insertion.join() }
            val source = withContext(Dispatchers.Main) { controller.sourceText() }
            if (retired) {
                assertEquals("other unchanged", source)
                assertFalse(File(root, "accepted.png").exists())
                assertEquals("before", store.core.read("origin"))
                return@runBlocking
            }
            assertTrue("the native view accepted the image before cancellation", source!!.contains("![](accepted.png)"))
            assertTrue("accepted Markdown must never point at a cancellation-deleted file", File(root, "accepted.png").exists())
            if (attached) {
                compose.waitUntil(10_000) {
                    val layout = controller.view.layout
                    layout != null && layout.getLineBottom(0) >= 360
                }
                compose.runOnUiThread {
                    val layout = controller.view.layout
                    val following = controller.view.text!!.indexOf("before")
                    assertTrue("text following a full-width photo belongs below it",
                        layout.getLineTop(layout.getLineForOffset(following)) >= 360)
                }
            }
        } finally {
            withContext(Dispatchers.Main) { controller.close(); controller.dispose(); store.scope.cancel() }
            store.core.destroy()
            scratch.deleteRecursively()
        }
    }
}

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

    /** The user's camera case: a tall photo over a paragraph, a quote and a heading. */
    @Test fun insertionAboveSeveralBlocksDisplacesEveryLineBelow() = exercise(
        attached = true, text = "It's a good day.\n\n> To be\n> or\n\n# Hey", bitmapSize = 2000 to 2500)

    /** The same, in a note that already holds a photo further down. */
    @Test fun insertionAboveAnExistingPhotoDisplacesEveryLineBelow() = exercise(
        attached = true, text = "It's a good day.\n\n> To be\n> or\n\n# Hey\n\n![](old.png)\n\nlast words",
        bitmapSize = 2000 to 2500, existing = "old.png")

    /** A recovered camera result inserts before the view has ever been laid out. */
    @Test fun insertionBeforeFirstLayoutDisplacesEveryLineBelow() = exercise(
        attached = true, attachAfterInsert = true, text = "It's a good day.\n\n> To be\n> or\n\n# Hey\n\n![](old.png)\n\nlast words",
        bitmapSize = 2000 to 2500, existing = "old.png")

    private fun exercise(attached: Boolean, retired: Boolean = false, text: String = "before", bitmapSize: Pair<Int, Int> = 640 to 360, existing: String? = null, attachAfterInsert: Boolean = false) = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scratch = File(context.cacheDir, "image-ack-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val root = File(scratch, "notes").apply { check(mkdirs()) }
        File(root, "origin.md").writeText(text)
        if (existing != null) {
            val old = Bitmap.createBitmap(1600, 1200, Bitmap.Config.ARGB_8888)
            old.eraseColor(Color.RED)
            File(root, existing).outputStream().use { out -> old.compress(Bitmap.CompressFormat.PNG, 100, out) }
            old.recycle()
        }
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
            if (attached && !attachAfterInsert) compose.activity.setContentView(controller.view)
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
                                // than a 1080 px screen); the default is square, which keeps the drawn height above the 360 px checks.
                                val side = maxOf(bitmapSize.first, context.resources.displayMetrics.widthPixels)
                                val tall = if (bitmapSize == 640 to 360) side else bitmapSize.second
                                val bitmap = Bitmap.createBitmap(side, tall, Bitmap.Config.ARGB_8888)
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
            if (attachAfterInsert) withContext(Dispatchers.Main) { compose.activity.setContentView(controller.view) }
            if (attached) {
                val shown = 300
                compose.waitUntil(10_000) {
                    val layout = controller.view.layout
                    layout != null && layout.getLineBottom(0) >= shown
                }
                // Let the bitmap land and any reflow settle, then every later line must clear the image.
                Thread.sleep(500)
                compose.runOnUiThread {
                    val view = controller.view
                    val layout = view.layout
                    val image = layout.getLineBottom(0)
                    val shownText = view.text!!.toString()
                    for (word in text.lines().filter { !it.startsWith("![") }.joinToString(" ").split(Regex("\\W+")).filter { it.length > 1 }) {
                        val at = shownText.indexOf(word)
                        assertTrue("$word is in the display", at >= 0)
                        assertTrue("text following a photo belongs below it: '$word' top ${layout.getLineTop(layout.getLineForOffset(at))} < image bottom $image",
                            layout.getLineTop(layout.getLineForOffset(at)) >= image)
                    }
                }
            }
        } finally {
            withContext(Dispatchers.Main) { controller.close(); controller.dispose(); store.scope.cancel() }
            store.core.destroy()
            scratch.deleteRecursively()
        }
    }
}

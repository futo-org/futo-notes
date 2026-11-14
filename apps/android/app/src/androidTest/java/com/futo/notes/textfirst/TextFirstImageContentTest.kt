package com.futo.notes.textfirst

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputContentInfo
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.content.FileProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.NotesStore
import java.io.File
import java.util.UUID
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Clipboard and keyboard images, driven through the real view, session and gated vault attachment. */
class TextFirstImageContentTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private class Harness(val scratch: File, val root: File, val store: NotesStore, val controller: TextFirstController,
        val uri: Uri, val scope: CoroutineScope, var busy: Int = 0, var unsupported: Int = 0)

    private fun png(): Pair<File, Uri> {
        val dir = File(context.cacheDir, "camera").apply { mkdirs() }
        val file = File(dir, "source-${UUID.randomUUID()}.png")
        val bitmap = Bitmap.createBitmap(64, 32, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        return file to FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    }

    private fun run(source: String = "before\n", body: suspend Harness.() -> Unit) = runBlocking {
        val scratch = File(context.cacheDir, "image-content-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val root = File(scratch, "notes").apply { check(mkdirs()) }
        File(root, "origin.md").writeText(source)
        lateinit var store: NotesStore
        compose.runOnUiThread { store = NotesStore(root, File(scratch, "index")) }
        compose.waitUntil(15_000) { store.hasBootstrapped }
        val (file, uri) = png()
        val opened = CompletableDeferred<Throwable?>()
        lateinit var controller: TextFirstController
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        lateinit var harness: Harness
        withContext(Dispatchers.Main) {
            val f = android.graphics.Typeface.DEFAULT
            controller = TextFirstController(compose.activity, { store.core }, root,
                TextFirstStyle(1f, 17f, f, f, f, f, Color.BLACK, Color.GRAY, Color.BLUE,
                    Color.GRAY, Color.WHITE, Color.WHITE), store)
            compose.activity.setContentView(controller.view)
            controller.open("origin") { opened.complete(it) }
            harness = Harness(scratch, root, store, controller, uri, scope)
            controller.acceptImageContent(store, context.contentResolver, scope,
                { harness.busy += it }, { harness.unsupported += 1 })
        }
        assertNull(opened.await())
        try { harness.body() } finally {
            scope.cancel()
            withContext(Dispatchers.Main) { controller.close(); controller.dispose(); store.scope.cancel() }
            store.core.destroy(); file.delete(); scratch.deleteRecursively()
        }
    }

    private fun Harness.images() = root.listFiles { f -> f.name.startsWith("image-") }.orEmpty()

    private suspend fun Harness.awaitReference(): String {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            val source = controller.sourceText()
            if (source != null && source.contains("![](")) return source
            delay(50)
        }
        return controller.sourceText().orEmpty()
    }

    private fun assertOnce(h: Harness, source: String) {
        assertEquals("exactly one reference: $source", 1, Regex("""!\[\]\(image-[^)]*\.png\)""").findAll(source).count())
        assertFalse("no URI text beside the image: $source", source.contains("content:") || source.contains("fileprovider"))
        assertEquals(1, h.images().size)
    }

    @Test fun clipboardImagePasteInsertsOneReferenceAndSurvivesReopen() = run {
        withContext(Dispatchers.Main) {
            context.getSystemService(ClipboardManager::class.java)
                .setPrimaryClip(ClipData.newUri(context.contentResolver, "image", uri))
            controller.select(6)
            controller.view.onTextContextMenuItem(android.R.id.paste)
        }
        val source = awaitReference()
        assertOnce(this, source)
        assertTrue(source.startsWith("before"))
        assertNotNull(withContext(Dispatchers.Main) { controller.checkpoint() })
        assertEquals(source, store.core.read("origin"))
        assertEquals(0, busy)
        val reopened = CompletableDeferred<Throwable?>()
        withContext(Dispatchers.Main) { assertNotNull(controller.close()); controller.open("origin") { reopened.complete(it) } }
        assertNull(reopened.await())
        assertEquals(source, controller.sourceText())
    }

    @Test fun keyboardContentInsertsOneReferenceAndSurvivesReopen() = run {
        val info = EditorInfo()
        val connection = withContext(Dispatchers.Main) { controller.view.onCreateInputConnection(info)!! }
        assertTrue("keyboard is told images are accepted", androidx.core.view.inputmethod.EditorInfoCompat.getContentMimeTypes(info).toList().any { it.startsWith("image/") })
        val accepted = withContext(Dispatchers.Main) {
            connection.commitContent(InputContentInfo(uri, ClipDescription("kb", arrayOf("image/png"))), 0, null)
        }
        assertTrue(accepted)
        val source = awaitReference()
        assertOnce(this, source)
        assertNotNull(withContext(Dispatchers.Main) { controller.checkpoint() })
        assertEquals(source, store.core.read("origin"))
    }

    @Test fun nonImageKeyboardContentIsRefusedAndNothingIsSaved() = run {
        val connection = withContext(Dispatchers.Main) { controller.view.onCreateInputConnection(EditorInfo())!! }
        val accepted = withContext(Dispatchers.Main) {
            connection.commitContent(InputContentInfo(uri, ClipDescription("kb", arrayOf("text/plain"))), 0, null)
        }
        assertFalse(accepted)
        assertEquals("before\n", controller.sourceText())
        assertEquals(0, images().size)
    }

    @Test fun contentAfterTheSessionClosedInsertsNothingAndLeavesNoFile() = run {
        withContext(Dispatchers.Main) { assertNotNull(controller.close()) }
        withContext(Dispatchers.Main) {
            context.getSystemService(ClipboardManager::class.java)
                .setPrimaryClip(ClipData.newUri(context.contentResolver, "image", uri))
            controller.view.onTextContextMenuItem(android.R.id.paste)
        }
        delay(1_000)
        assertEquals("before\n", store.core.read("origin"))
        assertEquals(0, images().size)
        assertEquals(0, busy)
    }

    @Test fun imagePasteInATableCellLeavesTheTableUntouched() = run(
        source = "intro\r\n\r\n| A | B |\r\n| --- | --- |\r\n| one | two |\r\n\r\nafter",
    ) {
        val before = controller.sourceText()
        withContext(Dispatchers.Main) {
            val at = controller.view.text.toString().indexOf("two")
            assertTrue(controller.selectDisplayRange(at, at + 3))
            context.getSystemService(ClipboardManager::class.java)
                .setPrimaryClip(ClipData.newUri(context.contentResolver, "image", uri))
            controller.cellView!!.onTextContextMenuItem(android.R.id.paste)
            val cell = controller.cellView!!.onCreateInputConnection(EditorInfo())
            assertFalse(cell.commitContent(InputContentInfo(uri, ClipDescription("kb", arrayOf("image/png"))), 0, null))
        }
        delay(500)
        assertEquals(before, controller.sourceText())
        assertEquals(0, images().size)
    }

    @Test fun plainTextPasteStillPastesText() = run {
        withContext(Dispatchers.Main) {
            context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText(null, " pasted"))
            controller.select(6)
            controller.view.onTextContextMenuItem(android.R.id.paste)
        }
        assertEquals("before pasted\n", controller.sourceText())
    }
}

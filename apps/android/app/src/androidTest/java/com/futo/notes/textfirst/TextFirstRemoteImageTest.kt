package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.NotesStore
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.ServerSocket
import java.util.UUID
import kotlin.concurrent.thread
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** HTTP bytes pass through the production loader and real native editor attachment. */
class TextFirstRemoteImageTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun remoteImageDecodesWithoutChangingItsMarkdownUrl() = runBlocking {
        val bytes = ByteArrayOutputStream().also { out ->
            Bitmap.createBitmap(32, 24, Bitmap.Config.ARGB_8888).apply {
                eraseColor(Color.MAGENTA)
                compress(Bitmap.CompressFormat.PNG, 100, out)
                recycle()
            }
        }.toByteArray()
        val server = ServerSocket(0)
        val serverThread = thread(isDaemon = true) {
            try { server.accept().use { socket ->
                val input = socket.getInputStream().bufferedReader()
                while (!input.readLine().isNullOrEmpty()) Unit
                socket.getOutputStream().apply {
                    write("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                    write(bytes)
                    flush()
                }
            } } catch (closed: java.net.SocketException) {
                if (!server.isClosed) throw closed
            }
        }
        val destination = "http://127.0.0.1:${server.localPort}/photo%20name.png?original=One%2FTwo"
        val source = "![remote]($destination)\n\nafter"
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scratch = File(context.cacheDir, "remote-image-${UUID.randomUUID()}").apply { check(mkdirs()) }
        val root = File(scratch, "notes").apply { check(mkdirs()) }
        File(root, "origin.md").writeText(source)
        lateinit var store: NotesStore
        lateinit var controller: TextFirstController
        compose.runOnUiThread { store = NotesStore(root, File(scratch, "index")) }
        compose.waitUntil(15_000) { store.hasBootstrapped }
        try {
            withContext(Dispatchers.Main) {
                val f = Typeface.DEFAULT
                controller = TextFirstController(compose.activity, { store.core }, root,
                    TextFirstStyle(1f, 17f, f, f, f, f, Color.BLACK, Color.GRAY, Color.BLUE,
                        Color.GRAY, Color.WHITE, Color.WHITE), store)
                compose.activity.setContentView(controller.view)
                val opened = CompletableDeferred<Throwable?>()
                controller.open("origin") { opened.complete(it) }
                assertNull(opened.await())
            }
            compose.waitUntil(10_000) {
                controller.view.text!!.getSpans(0, controller.view.length(), TfImage::class.java).singleOrNull()?.let {
                    it.bitmap != null || it.failed
                } == true
            }
            compose.runOnUiThread {
                val image = controller.view.text!!.getSpans(0, controller.view.length(), TfImage::class.java).single()
                assertFalse("HTTP images should decode rather than fail", image.failed)
                assertEquals(Color.MAGENTA, image.bitmap!!.getPixel(0, 0))
            }
            withContext(Dispatchers.Main) {
                assertEquals(source, controller.sourceText())
                assertNotNull(controller.checkpoint())
            }
            assertEquals(source, store.core.read("origin"))
        } finally {
            withContext(Dispatchers.Main) { controller.close(); controller.dispose(); store.scope.cancel() }
            store.core.destroy()
            server.close()
            serverThread.join(1000)
            scratch.deleteRecursively()
        }
    }
}

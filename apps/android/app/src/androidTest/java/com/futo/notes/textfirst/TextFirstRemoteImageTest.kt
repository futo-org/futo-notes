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
                controller.checkpoint()
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

    /** An unreachable image fails in place; the note stays editable and its URL byte-exact. */
    @Test fun unreachableImageFailsInPlaceAndKeepsSource() = runBlocking {
        val dead = ServerSocket(0).use { it.localPort }
        val destination = "http://127.0.0.1:$dead/gone.png"
        val source = "![offline]($destination)\n\nafter"
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
                controller.view.text!!.getSpans(0, controller.view.length(), TfImage::class.java).singleOrNull()?.failed == true
            }
            compose.runOnUiThread {
                val image = controller.view.text!!.getSpans(0, controller.view.length(), TfImage::class.java).single()
                assertNull(image.bitmap)
                assertTrue(controller.view.isEnabled)
            }
            withContext(Dispatchers.Main) { assertEquals(source, controller.sourceText()) }
            assertEquals(source, store.core.read("origin"))
        } finally {
            withContext(Dispatchers.Main) { controller.close(); controller.dispose(); store.scope.cancel() }
            store.core.destroy()
            scratch.deleteRecursively()
        }
    }

    /** A late result is dropped when the loader is retired: no callback reaches a recycled span. */
    @Test fun lateResultAfterShutdownNeverLands() = runBlocking {
        val bytes = ByteArrayOutputStream().also { out ->
            Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888).apply { compress(Bitmap.CompressFormat.PNG, 100, out); recycle() }
        }.toByteArray()
        val server = ServerSocket(0)
        val release = java.util.concurrent.CountDownLatch(1)
        val accepted = java.util.concurrent.CountDownLatch(1)
        val serverThread = thread(isDaemon = true) {
            try { server.accept().use { socket ->
                val input = socket.getInputStream().bufferedReader()
                while (!input.readLine().isNullOrEmpty()) Unit
                accepted.countDown()
                release.await()
                runCatching {
                    socket.getOutputStream().apply {
                        write("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                        write(bytes); flush()
                    }
                }
            } } catch (_: java.net.SocketException) {}
        }
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val loader = ImageLoader(context, context.cacheDir)
        val landed = java.util.concurrent.atomic.AtomicInteger()
        try {
            withContext(Dispatchers.Main) { loader.load("http://127.0.0.1:${server.localPort}/slow.png", false, true, 100) { landed.incrementAndGet() } }
            assertTrue(accepted.await(10, java.util.concurrent.TimeUnit.SECONDS))
            withContext(Dispatchers.Main) { loader.shutdown() }
            release.countDown()
            delay(1500)
            assertEquals("a retired loader must not deliver", 0, landed.get())
        } finally {
            release.countDown()
            server.close()
            serverThread.join(1000)
        }
    }
}

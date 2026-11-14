package com.futo.notes.textfirst

import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertNull
import uniffi.futo_notes_ffi.NoteStore

// A long note open in a bare text-first controller with its tail paused, for
// tests of ordered commands against bounded, acknowledged rendering.

internal class StreamingTrace {
    val appendSizes = mutableListOf<Int>()
    val windowSizes = mutableListOf<Int>()
    var heartbeats = 0
    var renderApplies = 0
    var interleaved = true
}
internal class StreamingRig(val scenario: ActivityScenario<ComponentActivity>, val controller: TextFirstController, val store: NoteStore) {
    val engine get() = controller.view.engine!!
    val original = source()
    fun ui(block: () -> Unit) = scenario.onActivity { block() }
    fun barrier() {
        val done = CountDownLatch(1)
        engine.handler.post { engine.ui.post { done.countDown() } }
        check(done.await(20, TimeUnit.SECONDS))
    }
    fun source() = runBlocking { controller.sourceText() }!!
    fun display(): String {
        var display = ""
        val done = CountDownLatch(1)
        engine.handler.post { display = engine.text.toString(); done.countDown() }
        check(done.await(10, TimeUnit.SECONDS))
        return display
    }
    fun awaitComplete() = runBlocking {
        withTimeout(30_000) {
            while (true) {
                var complete = false
                ui { complete = controller.view.contentComplete }
                if (complete) break
                delay(10)
            }
        }
    }
    fun trace() = StreamingTrace().also { trace ->
        ui {
            controller.view.onApplyMeasured = { _, update ->
                if (update.append) trace.appendSizes += update.edits.sumOf { it.text.length }
                if (update.windows.isNotEmpty()) trace.windowSizes += update.windows.maxOf { it.end - it.start }
                if (update.append || update.windows.isNotEmpty()) {
                    if (trace.heartbeats < trace.renderApplies) trace.interleaved = false
                    trace.renderApplies++
                    controller.view.post { trace.heartbeats++ }
                }
            }
        }
    }
}
internal fun streamingExercise(body: String? = null, check: StreamingRig.() -> Unit) {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = File(context.cacheDir, "streaming-command-${UUID.randomUUID()}").apply { check(mkdirs()) }
    val store = NoteStore(root.path)
    val scenario = ActivityScenario.launch(ComponentActivity::class.java)
    lateinit var controller: TextFirstController
    val opened = CountDownLatch(1)
    try {
        store.createNote("n", "", body ?: (0 until 2_000).joinToString("") { "paragraph $it\n\n" })
        scenario.onActivity { activity ->
            controller = createTextFirstController(activity, { store }, root)
            activity.setContentView(controller.view)
            controller.open("n") {
                assertNull(it)
                controller.view.engine!!.handler.post {
                    controller.view.engine!!.handler.removeCallbacks(controller.view.engine!!.tailRunnable)
                    opened.countDown()
                }
            }
        }
        check(opened.await(10, TimeUnit.SECONDS))
        StreamingRig(scenario, controller, store).check()
    } finally {
        if (controller.view.engine != null) runBlocking { controller.discard() }
        scenario.onActivity { controller.dispose() }
        scenario.close()
        store.destroy()
        root.deleteRecursively()
    }
}

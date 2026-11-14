package com.futo.notes.textfirst

import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.SystemClock
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.NoteStore

/** Opt in with -e textFirstCommandBench true. Emulator results diagnose stages; Moto judges budgets. */
class TextFirstCommandBenchmarkTest {
    @Test fun measureSyntheticLargeNoteCommands() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("textFirstCommandBench") == "true")
        val options = TextFirstBenchmarkOptions(args)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val run = UUID.randomUUID().toString()
        val root = File(context.cacheDir, "command-bench-$run").apply { check(mkdirs()) }
        val store = NoteStore(root.path)
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val results = JSONArray()
        var completed = false
        try {
            val commands = listOf(
                "heading-1" to EditorBlockCommand.ToggleHeading(1u),
                "heading-2" to EditorBlockCommand.ToggleHeading(2u),
                "heading-3" to EditorBlockCommand.ToggleHeading(3u),
                "quote" to EditorBlockCommand.Quote,
                "bullet-list" to EditorBlockCommand.BulletList,
                "ordered-list" to EditorBlockCommand.OrderedList,
                "task-list" to EditorBlockCommand.TaskList,
                "code-block" to EditorBlockCommand.WrapCodeBlock,
                "indent" to EditorBlockCommand.Indent,
                "outdent" to EditorBlockCommand.Outdent,
            )
            val allowed = commands.map { "all-${it.first}" }.toSet() + setOf("select-all", "middle-list-toggle", "quote-type")
            val actions = options.actions("textFirstCommandBenchActions", allowed)
            val mixed = options.externalSource ?: TextFirstSyntheticNotes.mixed
            fun measured(name: String, source: String, selectAll: Boolean, action: (TextFirstController) -> Unit) {
                if (name !in actions) return
                try {
                    results.put(measure(scenario, store, root, name, source, selectAll, options, action))
                } catch (error: Throwable) {
                    results.put(JSONObject().put("action", name).put("error", error.javaClass.simpleName))
                    writeReport(context, run, results)
                    throw error
                }
                writeReport(context, run, results)
            }
            measured("select-all", mixed, false) { it.view.engine!!.selectAll() }
            for ((name, command) in commands) {
                measured("all-$name", mixed, true) { it.block(command) }
            }
            measured("middle-list-toggle", mixed, false) { it.block(EditorBlockCommand.BulletList) }
            measured("quote-type", options.externalSource ?: TextFirstSyntheticNotes.quote, false) {
                val connection = it.view.onCreateInputConnection(EditorInfo())!!
                connection.handler!!.post { connection.commitText("x", 1) }
            }
            writeReport(context, run, results)
            completed = true
        } finally {
            scenario.close()
            store.destroy()
            // A timed-out atomic command may still own this private scratch vault.
            if (completed) root.deleteRecursively()
        }
    }

    private fun measure(
        scenario: ActivityScenario<ComponentActivity>, store: NoteStore, root: File,
        name: String, source: String, selectAll: Boolean, options: TextFirstBenchmarkOptions,
        action: (TextFirstController) -> Unit,
    ): JSONObject {
        store.createNote(name, "", source)
        lateinit var controller: TextFirstController
        var created: TextFirstController? = null
        val opened = CountDownLatch(1)
        val drawn = CountDownLatch(1)
        val settled = CountDownLatch(1)
        var began = Long.MAX_VALUE
        var timings: KeyTimings? = null
        var drawnAtNs = 0L
        var appendTextNs = 0L
        var appendSpansNs = 0L
        var appendChunks = 0
        var settledAtNs = 0L
        var maxAppendApplyNs = 0L
        var maxApplyNs = 0L
        var heartbeats = 0
        var applies = 0
        var interleaved = true
        try {
            scenario.onActivity { activity ->
                controller = createTextFirstController(activity, { store }, root)
                created = controller
                activity.setContentView(controller.view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                controller.view.onFrameDrawn = { sample ->
                    if (sample.input >= began && drawn.count > 0L) {
                        timings = sample
                        drawnAtNs = SystemClock.elapsedRealtimeNanos()
                        drawn.countDown()
                    }
                }
                controller.view.onApplyMeasured = { sample, update ->
                    if (sample.applyStart >= began) {
                        maxApplyNs = maxOf(maxApplyNs, sample.applyEnd - sample.applyStart)
                        if (applies > heartbeats) interleaved = false
                        applies++
                        controller.view.post { heartbeats++ }
                    }
                    if (update.append && sample.applyStart >= began) {
                        maxAppendApplyNs = maxOf(maxAppendApplyNs, sample.applyEnd - sample.applyStart)
                        appendTextNs += sample.editsEnd - sample.applyStart
                        appendSpansNs += sample.applyEnd - sample.editsEnd
                        appendChunks++
                    }
                }
                controller.view.onRenderFrame = { now ->
                    if (timings != null && controller.view.contentComplete && settled.count > 0L) {
                        settledAtNs = now
                        settled.countDown()
                    }
                }
                controller.open(name) { check(it == null) { it.toString() }; opened.countDown() }
            }
            check(opened.await(options.timeoutSeconds, TimeUnit.SECONDS)) { "$name did not open" }
            val engine = controller.view.engine!!
            val positioned = CountDownLatch(1)
            val selectionBegan = SystemClock.elapsedRealtimeNanos()
            var beforeRevision = 0uL
            engine.handler.post {
                val text = engine.text
                val middleList = text.indexOf("list 1000")
                val middle = when {
                    name == "select-all" -> 0
                    options.offset != null -> options.offset.also { require(it <= text.length) { "Benchmark display offset is outside the note" } }
                    middleList >= 0 -> middleList
                    else -> text.indexOf('\n', text.length / 2).coerceAtLeast(0)
                }
                engine.select(if (selectAll) 0 else middle, if (selectAll) text.length else middle, false, finishTail = false)
                if (name != "select-all") engine.streamTail(0)
                beforeRevision = engine.rev
                engine.ui.post { positioned.countDown() }
            }
            check(positioned.await(options.timeoutSeconds, TimeUnit.SECONDS)) { "$name selection timed out" }
            if (name != "select-all" && options.fullyShown) runBlocking {
                withTimeout(options.timeoutSeconds * 1_000L) {
                    while (true) {
                        var complete = false
                        scenario.onActivity { complete = controller.view.contentComplete }
                        if (complete) break
                        delay(10)
                    }
                }
            }
            val selectionSetupNs = SystemClock.elapsedRealtimeNanos() - selectionBegan
            began = SystemClock.elapsedRealtimeNanos()
            scenario.onActivity { activity ->
                controller.view.isFocusableInTouchMode = true
                controller.view.requestFocus()
                action(controller)
            }
            val delivered = CountDownLatch(1)
            var afterRevision = beforeRevision
            engine.handler.post { afterRevision = engine.rev; engine.ui.post { delivered.countDown() } }
            check(delivered.await(options.timeoutSeconds, TimeUnit.SECONDS)) { "$name command timed out" }
            val completed = SystemClock.elapsedRealtimeNanos()
            val changed = beforeRevision != afterRevision
            if (changed || name == "select-all") {
                check(drawn.await(options.timeoutSeconds, TimeUnit.SECONDS)) { "$name did not draw" }
                check(settled.await(options.timeoutSeconds, TimeUnit.SECONDS)) { "$name background rendering did not finish" }
                val logical = engine.publishedSelection
                scenario.onActivity {
                    check(controller.view.selectionStart == (logical ushr 32).toInt() && controller.view.selectionEnd == (logical and 0xffffffffL).toInt()) { "Final displayed selection differs from logical selection" }
                }
            }
            val t = timings
            return JSONObject().put("action", name).put("sourceBytes", source.toByteArray().size)
                .put("privateFixture", options.externalSource != null)
                .put("selectionSetupNs", selectionSetupNs)
                .put("changed", changed).put("workerAndApplyDeliveryNs", completed - began)
                .put("firstInteractiveFrameNs", if (drawnAtNs > 0L) drawnAtNs - began else null)
                .put("backgroundCompleteFrameNs", if (settledAtNs > 0L) settledAtNs - began else null)
                .put("completedFrameNs", if (settledAtNs > 0L) settledAtNs - began else null)
                .put("maxApplyNs", maxApplyNs).put("maxAppendApplyNs", maxAppendApplyNs)
                .put("uiHeartbeats", heartbeats).put("applies", applies).put("uiInterleaved", interleaved)
                .put("setupFullyShown", name != "select-all" && options.fullyShown)
                .put("appendChunks", appendChunks).put("appendTextNs", appendTextNs).put("appendSpansNs", appendSpansNs)
                .put("editorTotalNs", t?.let { it.posted - it.input })
                // Native work and the generated codec share this boundary. Pair with
                // TextFirstFfiCallBenchmarkTest to estimate the crossing's overhead.
                .put("nativeAndFfiNs", t?.let { if (it.engine > 0L) it.engine - it.input else null })
                .put("spanPlanningNs", t?.let { if (it.engine > 0L) it.posted - it.engine else null })
                .put("uiTextNs", t?.let { it.editsEnd - it.applyStart })
                .put("uiSpansNs", t?.let { it.applyEnd - it.editsEnd })
                .put("drawNs", t?.let { it.drawEnd - it.drawStart })
                .put("imeResets", controller.imeResets)
        } finally {
            created?.let { openedController ->
                try {
                    runBlocking { withTimeout(options.timeoutSeconds * 1_000L) { openedController.close() } }
                } finally { scenario.onActivity { openedController.dispose() } }
            }
        }
    }

    private fun writeReport(context: android.content.Context, run: String, results: JSONArray) {
        val report = JSONObject().put("runId", run).put("model", Build.MODEL).put("sdk", Build.VERSION.SDK_INT)
            .put("debuggable", context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
            .put("actions", results)
        File(context.getExternalFilesDir(null), "text-first-commands-$run.json").writeText(report.toString())
    }
}

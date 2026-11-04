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
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val run = UUID.randomUUID().toString()
        val root = File(context.cacheDir, "command-bench-$run").apply { check(mkdirs()) }
        val store = NoteStore(root.path)
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        val results = JSONArray()
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
            for ((name, command) in commands) {
                results.put(measure(scenario, store, root, "all-$name", TextFirstSyntheticNotes.mixed, true) {
                    it.block(command)
                })
                writeReport(context, run, results)
            }
            results.put(measure(scenario, store, root, "middle-list-toggle", TextFirstSyntheticNotes.mixed, false) {
                it.block(EditorBlockCommand.BulletList)
            })
            results.put(measure(scenario, store, root, "quote-type", TextFirstSyntheticNotes.quote, false) {
                val connection = it.view.onCreateInputConnection(EditorInfo())!!
                connection.handler!!.post { connection.commitText("x", 1) }
            })
            writeReport(context, run, results)
        } finally {
            scenario.close()
            store.destroy()
            root.deleteRecursively()
        }
    }

    private fun measure(
        scenario: ActivityScenario<ComponentActivity>, store: NoteStore, root: File,
        name: String, source: String, selectAll: Boolean,
        action: (TextFirstController) -> Unit,
    ): JSONObject {
        store.createNote(name, "", source)
        lateinit var controller: TextFirstController
        var created: TextFirstController? = null
        val opened = CountDownLatch(1)
        val drawn = CountDownLatch(1)
        var began = Long.MAX_VALUE
        var timings: KeyTimings? = null
        try {
            scenario.onActivity { activity ->
                controller = createTextFirstController(activity, { store }, root)
                created = controller
                activity.setContentView(controller.view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                controller.view.onFrameDrawn = { sample ->
                    if (sample.input >= began) { timings = sample; drawn.countDown() }
                }
                controller.open(name) { check(it == null) { it.toString() }; opened.countDown() }
            }
            check(opened.await(120, TimeUnit.SECONDS)) { "$name did not open" }
            val engine = controller.view.engine!!
            val positioned = CountDownLatch(1)
            engine.handler.post {
                val text = engine.text
                val middleList = text.indexOf("list 1000")
                val middle = if (middleList >= 0) middleList else text.indexOf('\n', text.length / 2).coerceAtLeast(0)
                engine.select(if (selectAll) 0 else middle, if (selectAll) text.length else middle, false)
                engine.ui.post { positioned.countDown() }
            }
            check(positioned.await(120, TimeUnit.SECONDS)) { "$name selection timed out" }
            val before = runBlocking { controller.sourceText() }
            began = SystemClock.elapsedRealtimeNanos()
            scenario.onActivity { activity ->
                controller.view.isFocusableInTouchMode = true
                controller.view.requestFocus()
                action(controller)
            }
            val after = runBlocking { controller.sourceText() }
            val completed = SystemClock.elapsedRealtimeNanos()
            val changed = before != after
            if (changed) check(drawn.await(120, TimeUnit.SECONDS)) { "$name changed but did not draw" }
            val t = timings
            return JSONObject().put("action", name).put("sourceBytes", source.toByteArray().size)
                .put("changed", changed).put("commandAndDeliveryNs", completed - began)
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
                runBlocking { openedController.close() }
                scenario.onActivity { openedController.dispose() }
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

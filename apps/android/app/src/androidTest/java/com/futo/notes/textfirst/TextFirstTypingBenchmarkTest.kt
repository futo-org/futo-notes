package com.futo.notes.textfirst

import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.os.Build
import android.os.SystemClock
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.core.content.res.ResourcesCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.R
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import uniffi.futo_notes_ffi.NoteStore

/**
 * Key → drawn frame on the real text-first view, for corpus notes. Each key
 * goes through the same input connection a keyboard uses (on the editor
 * thread), and is timed from the moment the test hands it over until the
 * view's onDraw has drawn the resulting update. Driven by
 * scripts/android-text-first-bench.mjs on the non-debuggable perf app.
 *
 * What it does not include: the keyboard's own time before it calls the
 * connection, RenderThread/GPU time after onDraw, and display latency.
 */
class TextFirstTypingBenchmarkTest {
    @Test
    fun measureKeyToDraw() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("textFirstBench") == "true")
        val runId = (args.getString("textFirstBenchRunId") ?: "local").also {
            require(it.matches(Regex("[A-Za-z0-9._-]+"))) { "Invalid benchmark run id" }
        }
        val typed = args.getString("textFirstBenchTyped")?.toInt() ?: 100
        val options = TextFirstBenchmarkOptions(args)
        val selectedActions = options.actions("textFirstBenchActions", setOf("type", "enter", "backspace"))
        // Quick runs: the same key count for every action, a time box per
        // series, and fewer warm-up keys (scripts/android-text-first-bench.mjs --quick).
        val plan = KeyPlan(
            type = args.getString("textFirstBenchKeys")?.toInt() ?: typed,
            enter = args.getString("textFirstBenchKeys")?.toInt() ?: (typed / 5),
            backspace = args.getString("textFirstBenchKeys")?.toInt() ?: (typed / 2),
            warmup = args.getString("textFirstBenchWarmup")?.toInt() ?: 20,
            seriesBudgetNs = (args.getString("textFirstBenchSeriesBudgetMs")?.toLong() ?: 0L) * 1_000_000L,
            settleMs = args.getString("textFirstBenchSettleMs")?.toLong() ?: 30L,
        )
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        // Pushed by the runner to /data/local/tmp and read as plain files.
        // Reading them through UiAutomation switched accessibility on in this
        // process (even with FLAG_DONT_USE_ACCESSIBILITY), so every key paid
        // for accessibility events no ordinary user's phone sends. (Files adb
        // pushes into the app's own external dir are EACCES to the app.)
        val baseline = args.getString("textFirstBenchBaseline") == "true"
        val fixtures = File(args.getString("textFirstBenchDirectory") ?: "/data/local/tmp/tf-bench")
        val targets = mutableMapOf<String, JSONObject>()
        fun shellRead(name: String): String = File(fixtures, name).readText()
        val notes = if (options.externalSource != null) {
            listOf("external-fixture" to options.externalSource)
        } else if (args.getString("textFirstBenchSynthetic") == "true") {
            TextFirstSyntheticNotes.all
        } else {
            val manifest = JSONArray(shellRead("manifest.json"))
            List(manifest.length()) { index ->
                val entry = manifest.getJSONObject(index)
                entry.getString("label").also { targets[it] = entry } to shellRead(entry.getString("file"))
            }
        }
        val vault = File(context.cacheDir, "tf-bench-vault-$runId-${java.util.UUID.randomUUID()}").apply { check(mkdirs()) }
        val store = NoteStore(vault.absolutePath)
        val results = JSONArray()
        var completed = false
        var failed = false
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        try {
            for ((i, note) in notes.withIndex()) {
                val (label, source) = note
                val id = "bench-$i"
                store.createNote(id, "", source)
                val result = try {
                    measureNote(scenario, store, id, label, plan, options, selectedActions, if (baseline) targets.getValue(label) else null)
                } catch (e: Throwable) {
                    failed = true
                    // One failing note is a finding, not a reason to lose the run.
                    JSONObject().put("label", label).put("error", if (options.externalSource != null) e.javaClass.simpleName else e.stackTraceToString().take(4000))
                }
                results.put(result)
                writeReport(context, runId, results)
            }
            completed = !failed
        } finally {
            scenario.close()
            store.destroy()
            if (completed) vault.deleteRecursively()
        }
        writeReport(context, runId, results)
    }

    private fun writeReport(context: android.content.Context, runId: String, results: JSONArray) {
        val accessibility = context.getSystemService(android.view.accessibility.AccessibilityManager::class.java).isEnabled
        val report = JSONObject()
            .put("formatVersion", 2)
            .put("accessibilityEnabled", accessibility)
            .put("runId", runId)
            .put("model", Build.MODEL)
            .put("sdk", Build.VERSION.SDK_INT)
            .put("debuggable", context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
            .put("notes", results)
        File(context.getExternalFilesDir(null), "text-first-bench-$runId.json").writeText(report.toString())
    }

    private fun measureNote(
        scenario: ActivityScenario<ComponentActivity>,
        store: NoteStore,
        id: String,
        label: String,
        plan: KeyPlan,
        options: TextFirstBenchmarkOptions,
        selectedActions: Set<String>,
        target: JSONObject?,
    ): JSONObject {
        lateinit var controller: TextFirstController
        val drawn = arrayOfNulls<CountDownLatch>(1)
        val drawnAt = LongArray(1)
        val awaitingInput = java.util.concurrent.atomic.AtomicLong(0)
        val firstTextAt = java.util.concurrent.atomic.AtomicLong(0)
        var lastTimings: KeyTimings? = null
        val opened = CountDownLatch(1)
        val openStarted = SystemClock.elapsedRealtimeNanos()
        var openNs = 0L
        var originalChars = 0
        var targetOffset = 0
        var originalSource = ""
        var setupError: Throwable? = null
        scenario.onActivity { activity ->
            controller = TextFirstController(activity, { store }, activity.cacheDir, style(activity))
            controller.view.onRenderFrame = { at ->
                if (controller.view.length() > 1) firstTextAt.compareAndSet(0, at)
            }
            controller.view.onFrameDrawn = { timings ->
                if (awaitingInput.get() > 0 && timings.input >= awaitingInput.get()) {
                    drawnAt[0] = SystemClock.elapsedRealtimeNanos()
                    lastTimings = timings
                    drawn[0]?.countDown()
                }
            }
            activity.setContentView(FrameLayout(activity).apply {
                addView(controller.view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            })
            controller.open(id) {
                controller.view.post {
                    openNs = SystemClock.elapsedRealtimeNanos() - openStarted
                    opened.countDown()
                }
            }
        }
        check(opened.await(options.timeoutSeconds, TimeUnit.SECONDS)) { "$label did not open" }
        // Position against the complete worker mirror, not the progressively
        // opened view prefix. No full-note string is copied on the main thread.
        lateinit var ic: InputConnection
        val positioned = CountDownLatch(1)
        val selectionBegan = SystemClock.elapsedRealtimeNanos()
        val engine = controller.view.engine!!
        engine.handler.post {
            try {
                val text = engine.text
                originalChars = text.length
                originalSource = engine.session!!.sourceText()
                val mid = if (target != null) {
                    val sourceByte = target.getLong("sourceByte").toULong()
                    val projection = engine.session!!.project(engine.rev, engine.mirror.byteRange(0, text.length))
                    val run = projection.correspondence.firstOrNull {
                        it.kind == uniffi.futo_notes_ffi.EditorCorrespondenceKind.LITERAL &&
                            sourceByte > it.source.start && sourceByte <= it.source.end
                    } ?: error("Target is not literal text in canonical projection")
                    engine.mirror.toUtf16((run.display.start + sourceByte - run.source.start).toInt())
                } else options.offset?.also { require(it <= text.length) }
                    ?: text.indexOf('\n', text.length / 2).let { if (it < 0) text.length else it }
                targetOffset = mid
                if (target?.optBoolean("cell") == true) engine.showDisplayRange(mid, mid)
                else engine.select(mid, mid, false)
                engine.ui.post {
                    try {
                        controller.view.requestFocus()
                        controller.view.bringPointIntoView(mid)
                        val inputView = if (target?.optBoolean("cell") == true)
                            checkNotNull(controller.cellView) { "Table target did not open a cell" } else controller.view
                        ic = inputView.onCreateInputConnection(EditorInfo())!!
                    } catch (error: Throwable) { setupError = error }
                    controller.view.postOnAnimation { positioned.countDown() }
                }
            } catch (error: Throwable) { setupError = error; positioned.countDown() }
        }
        check(positioned.await(options.timeoutSeconds, TimeUnit.SECONDS)) { "$label selection timed out" }
        setupError?.let { throw it }
        val selectionSetupNs = SystemClock.elapsedRealtimeNanos() - selectionBegan
        val handler = ic.handler!!
        val vsyncs = VsyncRecorder()
        val phase = kotlin.random.Random(283)
        scenario.onActivity { vsyncs.start(it.display?.refreshRate ?: 60f) }
        // Per key: total, then the stages (editor thread, queue to UI, text,
        // spans, wait for frame, draw), frames late, then the editor thread's
        // split: the engine call, and the Kotlin after it. A refused key (the
        // engine changed nothing and the keyboard restarts) is not timed.
        // Keys land at a random point of the 16.7 ms frame, as typing does;
        // a fixed rhythm would line every key up just after a vsync.
        var timedOut = false
        fun key(action: (InputConnection) -> Unit): LongArray {
            if (timedOut) return longArrayOf(TIMED_OUT)
            val latch = CountDownLatch(1)
            drawn[0] = latch
            lastTimings = null
            val resets = controller.imeResets
            val started = SystemClock.elapsedRealtimeNanos()
            awaitingInput.set(started)
            handler.post { action(ic) }
            var ok = false
            while (!ok && SystemClock.elapsedRealtimeNanos() - started < KEY_TIMEOUT_NS) {
                ok = latch.await(5, TimeUnit.MILLISECONDS)
                if (controller.imeResets != resets) break
            }
            awaitingInput.set(0)
            drawn[0] = null
            SystemClock.sleep(plan.settleMs + phase.nextLong(17))
            val t = lastTimings
            if (controller.imeResets != resets) return longArrayOf(REFUSED)
            if (!ok || t == null) { timedOut = true; return longArrayOf(TIMED_OUT) }
            return longArrayOf(
                drawnAt[0] - started,
                t.posted - started,
                t.applyStart - t.posted,
                t.editsEnd - t.applyStart,
                t.applyEnd - t.editsEnd,
                t.drawStart - t.applyEnd,
                t.drawEnd - t.drawStart,
                vsyncs.framesLate(started, t.drawStart).toLong(),
                if (t.engine > 0) t.engine - started else -1,
                if (t.engine > 0) t.posted - t.engine else -1,
            )
        }
        fun restore() {
            if (target == null || timedOut) return
            val restored = CountDownLatch(1)
            var failure: Throwable? = null
            engine.handler.post {
                try {
                    val change = engine.session!!.undo(engine.rev) ?: error("Trial made no undoable edit")
                    engine.accept(change)
                    check(engine.session!!.sourceText() == originalSource) { "Undo failed to restore exact fixture" }
                    if (target.optBoolean("cell")) engine.showDisplayRange(targetOffset, targetOffset)
                    else engine.select(targetOffset, targetOffset, false)
                    engine.ui.post {
                        controller.view.postOnAnimation { controller.view.post { restored.countDown() } }
                    }
                } catch (error: Throwable) { failure = error; restored.countDown() }
            }
            check(restored.await(options.timeoutSeconds, TimeUnit.SECONDS)) { "Restore timed out" }
            failure?.let { throw it }
        }
        fun series(name: String, count: Int, action: (InputConnection) -> Unit): JSONObject {
            val samples = mutableListOf<LongArray>()
            val began = SystemClock.elapsedRealtimeNanos()
            while (samples.size < count &&
                (plan.seriesBudgetNs <= 0 || samples.size < MIN_SAMPLES ||
                    SystemClock.elapsedRealtimeNanos() - began < plan.seriesBudgetNs)
            ) {
                samples += key(action)
                if (timedOut) break
                restore()
            }
            val timed = samples.filter { it.size > 1 }
            fun p(values: List<Long>, q: Int) = values[((values.size - 1) * q + 50) / 100]
            val result = JSONObject().put("action", name).put("samples", timed.size)
                .put("requested", count)
                .put("rawNs", JSONArray(timed.map { JSONArray(it.toList()) }))
                .put("refused", samples.count { it[0] == REFUSED })
                .put("timedOut", samples.count { it[0] == TIMED_OUT })
            if (timed.isEmpty()) return result
            val ns = timed.map { it[0] }.sorted()
            val names = listOf("editor", "queue", "text", "spans", "frameWait", "draw", "late", "engine", "kotlin")
            val stageP50 = JSONObject()
            for ((i, n) in names.withIndex()) {
                val v = timed.map { it[i + 1] }.filter { it >= 0 }.sorted()
                if (n != "late" && v.isNotEmpty()) stageP50.put(n, p(v, 50)).put("${n}P95", p(v, 95))
            }
            val late = timed.map { it[7] }.sorted()
            return result
                .put("p50Ns", p(ns, 50)).put("p95Ns", p(ns, 95)).put("maxNs", ns.last())
                .put("over16ms", ns.count { it > 16_700_000L })
                .put("framesLateP50", p(late, 50)).put("framesLateP95", p(late, 95))
                .put("onTime", late.count { it == 0L })
                .put("stagesNs", stageP50)
        }
        repeat(plan.warmup) { if (!timedOut) { key { it.commitText("w", 1) }; restore() } }
        val actions = JSONArray()
        if ("type" in selectedActions) actions.put(series("type", plan.type) { it.commitText("a", 1) })
        if ("enter" in selectedActions && target?.optBoolean("cell") != true) actions.put(series("enter", plan.enter) { it.commitText("\n", 1) })
        if ("backspace" in selectedActions) actions.put(series("backspace", plan.backspace) { it.deleteSurroundingText(1, 0) })
        scenario.onActivity { vsyncs.stop() }
        // Off the main thread: close() answers through a main-thread post.
        kotlinx.coroutines.runBlocking { kotlinx.coroutines.withTimeout(options.timeoutSeconds * 1_000L) { controller.close() } }
        if (target != null && !timedOut) check(store.read(id) == originalSource) { "Saved fixture differs after restored trials" }
        scenario.onActivity { activity ->
            controller.dispose()
            activity.setContentView(FrameLayout(activity))
        }
        return JSONObject()
            .put("label", label)
            .put("chars", originalChars)
            .put("targetDisplayUtf16", targetOffset)
            .put("restoredEachTrial", target != null)
            .put("cellInput", target?.optBoolean("cell") == true)
            .put("openNs", openNs)
            .put("firstTextDrawNs", firstTextAt.get() - openStarted)
            .put("privateFixture", options.externalSource != null)
            .put("selectionSetupNs", selectionSetupNs)
            .put("actions", actions)
    }

    private class KeyPlan(
        val type: Int,
        val enter: Int,
        val backspace: Int,
        val warmup: Int,
        /** 0 = no limit. After [MIN_SAMPLES], a series stops when this runs out. */
        val seriesBudgetNs: Long,
        val settleMs: Long,
    )

    private companion object {
        const val KEY_TIMEOUT_NS = 2_000_000_000L
        const val MIN_SAMPLES = 5
        const val REFUSED = -1L
        const val TIMED_OUT = -2L
    }

    private fun style(activity: ComponentActivity): TextFirstStyle {
        val metrics = activity.resources.displayMetrics
        val regular = ResourcesCompat.getFont(activity, R.font.barlow_regular)!!
        return TextFirstStyle(
            density = metrics.density,
            textSizePx = 17f * metrics.scaledDensity,
            regular = regular,
            semibold = ResourcesCompat.getFont(activity, R.font.barlow_semibold)!!,
            bold = ResourcesCompat.getFont(activity, R.font.barlow_bold)!!,
            mono = ResourcesCompat.getFont(activity, R.font.jetbrains_mono_regular)!!,
            textColor = Color.BLACK,
            mutedColor = Color.GRAY,
            linkColor = Color.rgb(242, 107, 31),
            borderColor = Color.LTGRAY,
            codeBackground = Color.rgb(231, 228, 223),
            surfaceColor = Color.rgb(244, 242, 239),
        )
    }
}

package com.futo.notes.textfirst

import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.os.Build
import android.os.SystemClock
import android.view.Choreographer
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
        val runId = args.getString("textFirstBenchRunId") ?: "local"
        val typed = args.getString("textFirstBenchTyped")?.toInt() ?: 100
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
        val fixtures = File("/data/local/tmp/tf-bench")
        fun shellRead(name: String): String = File(fixtures, name).readText()
        val notes = if (args.getString("textFirstBenchSynthetic") == "true") {
            TextFirstSyntheticNotes.all
        } else {
            val manifest = JSONArray(shellRead("manifest.json"))
            List(manifest.length()) { index ->
                val entry = manifest.getJSONObject(index)
                entry.getString("label") to shellRead(entry.getString("file"))
            }
        }
        val vault = File(context.cacheDir, "tf-bench-vault-$runId").apply { deleteRecursively(); check(mkdirs()) }
        val store = NoteStore(vault.absolutePath)
        val results = JSONArray()
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        try {
            for ((i, note) in notes.withIndex()) {
                val (label, source) = note
                val id = "bench-$i"
                store.createNote(id, "", source)
                val result = try {
                    measureNote(scenario, store, id, label, plan)
                } catch (e: Throwable) {
                    // One failing note is a finding, not a reason to lose the run.
                    JSONObject().put("label", label).put("error", e.stackTraceToString().take(4000))
                }
                results.put(result)
                writeReport(context, runId, results)
            }
        } finally {
            scenario.close()
            store.destroy()
            vault.deleteRecursively()
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
    ): JSONObject {
        lateinit var controller: TextFirstController
        val drawn = arrayOfNulls<CountDownLatch>(1)
        val drawnAt = LongArray(1)
        var lastTimings: KeyTimings? = null
        val opened = CountDownLatch(1)
        val openStarted = SystemClock.elapsedRealtimeNanos()
        var openNs = 0L
        scenario.onActivity { activity ->
            controller = TextFirstController(activity, { store }, activity.cacheDir, style(activity))
            controller.view.onFrameDrawn = { timings ->
                drawnAt[0] = SystemClock.elapsedRealtimeNanos()
                lastTimings = timings
                drawn[0]?.countDown()
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
        check(opened.await(120, TimeUnit.SECONDS)) { "$label did not open" }
        // The caret at the end of the line nearest the middle of the note.
        lateinit var ic: InputConnection
        scenario.onActivity {
            val text = controller.view.text.toString()
            val visible = text.length - TextFirstEditText.END_SENTINEL.length
            val mid = text.indexOf('\n', visible / 2).let { if (it < 0) visible else it }
            controller.view.requestFocus()
            controller.select(mid)
            controller.view.post { controller.view.bringPointIntoView(mid) }
            ic = controller.view.onCreateInputConnection(EditorInfo())!!
        }
        SystemClock.sleep(500)
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
        fun key(action: (InputConnection) -> Unit): LongArray {
            val latch = CountDownLatch(1)
            drawn[0] = latch
            lastTimings = null
            val resets = controller.imeResets
            val started = SystemClock.elapsedRealtimeNanos()
            handler.post { action(ic) }
            var ok = false
            while (!ok && SystemClock.elapsedRealtimeNanos() - started < KEY_TIMEOUT_NS) {
                ok = latch.await(5, TimeUnit.MILLISECONDS)
                if (controller.imeResets != resets) break
            }
            drawn[0] = null
            SystemClock.sleep(plan.settleMs + phase.nextLong(17))
            val t = lastTimings
            if (controller.imeResets != resets) return longArrayOf(REFUSED)
            if (!ok || t == null) return longArrayOf(TIMED_OUT)
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
        fun series(name: String, count: Int, action: (InputConnection) -> Unit): JSONObject {
            val samples = mutableListOf<LongArray>()
            val began = SystemClock.elapsedRealtimeNanos()
            while (samples.size < count &&
                (plan.seriesBudgetNs <= 0 || samples.size < MIN_SAMPLES ||
                    SystemClock.elapsedRealtimeNanos() - began < plan.seriesBudgetNs)
            ) samples += key(action)
            val timed = samples.filter { it.size > 1 }
            fun p(values: List<Long>, q: Int) = values[((values.size - 1) * q + 50) / 100]
            val result = JSONObject().put("action", name).put("samples", timed.size)
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
        repeat(plan.warmup) { key { it.commitText("w", 1) } }
        val actions = JSONArray()
            .put(series("type", plan.type) { it.commitText("a", 1) })
            .put(series("enter", plan.enter) { it.commitText("\n", 1) })
            .put(series("backspace", plan.backspace) { it.deleteSurroundingText(1, 0) })
        scenario.onActivity { vsyncs.stop() }
        // Off the main thread: close() answers through a main-thread post.
        kotlinx.coroutines.runBlocking { controller.close() }
        scenario.onActivity { activity ->
            controller.dispose()
            activity.setContentView(FrameLayout(activity))
        }
        return JSONObject()
            .put("label", label)
            .put("chars", controller.view.length())
            .put("openNs", openNs)
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

    /**
     * Vsyncs while a note is measured, in elapsedRealtimeNanos, so a key can
     * say how many frames it missed: 0 = drawn in the first frame that began
     * after the key was handed over. A blocked main thread delivers no
     * callbacks, so missed frames are counted in refresh periods, not callbacks.
     */
    private class VsyncRecorder : Choreographer.FrameCallback {
        private val times = LongArray(1 shl 16)
        @Volatile private var count = 0
        private var running = false
        private var periodNs = 16_666_667L

        fun start(refreshRate: Float) {
            periodNs = (1e9 / refreshRate).toLong()
            running = true
            Choreographer.getInstance().postFrameCallback(this)
        }
        fun stop() { running = false }

        override fun doFrame(frameTimeNanos: Long) {
            // Choreographer's clock is System.nanoTime; the key timings use elapsedRealtimeNanos.
            val vsync = SystemClock.elapsedRealtimeNanos() - (System.nanoTime() - frameTimeNanos)
            times[count and (times.size - 1)] = vsync
            count += 1
            if (running) Choreographer.getInstance().postFrameCallback(this)
        }

        fun framesLate(input: Long, drawStart: Long): Int {
            // The last vsync at or before the input, then the first after it.
            val n = count
            var before = input - periodNs
            for (i in n - 1 downTo maxOf(0, n - times.size)) {
                val v = times[i and (times.size - 1)]
                if (v <= input) { before = v; break }
            }
            var first = before + periodNs
            while (first <= input) first += periodNs
            return if (drawStart < first) 0 else ((drawStart - first) / periodNs).toInt()
        }
    }

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

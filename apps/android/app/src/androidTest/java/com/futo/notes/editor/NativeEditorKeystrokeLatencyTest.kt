package com.futo.notes.editor

import android.content.pm.ApplicationInfo
import android.os.Build
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import uniffi.futo_notes_ffi.*

/**
 * Release-like keystroke latency: the full Kotlin -> UniFFI -> engine -> Store append path in a
 * non-debuggable app, measured after JIT warmup. Driven by scripts/android-keystroke-latency.mjs.
 */
class NativeEditorKeystrokeLatencyTest {
    @Test
    fun measureWarmKeystrokes() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("editorKeystrokeLatency") == "true")
        val runId = UUID.fromString(args.getString("editorKeystrokeRunId")).toString()
        val warmup = args.getString("editorKeystrokeWarmup")?.toInt() ?: 200
        val samples = args.getString("editorKeystrokeSamples")?.toInt() ?: 100
        require(samples >= 50) { "p95 needs at least 50 samples per shape" }
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val debuggable = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        val root = File(context.cacheDir, "editor-latency-vault-$runId")
        check(root.mkdirs())
        val lines = List(20_000) { "plain line $it" }.joinToString("\n")
        val shapes = listOf(
            "paragraph" to "A plain paragraph with **bold** and some text.\n",
            "20000-lines-paragraphs" to List(20_000) { if (it % 2 == 0) "plain paragraph $it" else "" }.joinToString("\n"),
            "20000-lines-single-paragraph" to lines,
            "20000-items-single-list" to List(20_000) { "- plain item $it" }.joinToString("\n"),
            "20000-code-lines-single-fence" to "```\n$lines\n```",
        )
        val results = JSONArray()
        try {
            NoteStore(root.absolutePath).use { store ->
                for ((index, shape) in shapes.withIndex()) {
                    val (name, source) = shape
                    store.createNote("shape-$index", "", source)
                    store.openEditor("shape-$index").use { session ->
                        var revision = session.revision()
                        var caret = 4uL
                        fun key(): Long {
                            val started = System.nanoTime()
                            val change = session.replaceUtf16Action(revision, EditorUtf16Range(caret, caret),
                                listOf(120u.toUShort()), EditorInputAction.TYPING)
                            val elapsed = System.nanoTime() - started
                            revision = change.revision
                            caret++
                            return elapsed
                        }
                        // Warm the JIT before the timed keys.
                        repeat(warmup) { key() }
                        val times = LongArray(samples) { key() }
                        session.detach()
                        val sorted = times.sorted()
                        fun percentile(p: Int) = sorted[((sorted.size - 1) * p + 50) / 100]
                        results.put(JSONObject().put("shape", name).put("samples", samples)
                            .put("p50Ns", percentile(50)).put("p95Ns", percentile(95)).put("maxNs", sorted.last())
                            .put("ns", JSONArray(times.toList())))
                    }
                }
            }
        } finally {
            root.deleteRecursively()
        }
        val report = JSONObject().put("formatVersion", 1).put("runId", runId).put("debuggable", debuggable)
            .put("model", Build.MODEL).put("sdk", Build.VERSION.SDK_INT)
            .put("supportedAbis", JSONArray(Build.SUPPORTED_ABIS)).put("warmupKeys", warmup)
            .put("shapes", results)
        val out = checkNotNull(context.getExternalFilesDir(null)) { "external files directory unavailable" }
        File(out, "editor-keystroke-latency-$runId.json").writeText(report.toString())
    }
}

package com.futo.notes.editor

import android.os.Build
import android.os.Process
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import uniffi.futo_notes_ffi.*

/** Reconnaissance only: measured wall time includes JNI/FFI, engine and Store append acceptance. */
class NativeEditorPerformanceReconTest {
    private data class Fixture(val name: String, val source: String)

    @Test
    fun recordProtectedNativeCallsAndExplicitFlushes() {
        assumeTrue("Native performance reconnaissance requires explicit editorPerformanceRecon=true",
            InstrumentationRegistry.getArguments().getString("editorPerformanceRecon") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val requestedRunId = requireNotNull(InstrumentationRegistry.getArguments().getString("editorPerformanceRunId"))
        val runId = UUID.fromString(requestedRunId).toString()
        require(runId == requestedRunId) { "A canonical probe UUID is required" }
        val mode = InstrumentationRegistry.getArguments().getString("editorPerformanceMode") ?: "full"
        require(mode == "full" || mode == "bounded-followup" || mode == "post-fix-checkpoint")
        val startedEpochMs = System.currentTimeMillis()
        val root = File(context.cacheDir, "editor-perf-vault-$runId")
        check(root.mkdirs())
        val samples = if (mode == "full") 100 else 4
        val flushPairs = if (mode == "full") 20 else 2
        val deadline = System.nanoTime() + 120_000_000_000L
        var phase = "setup"
        var outcome = "running"
        var failure: Throwable? = null
        val output = File(context.cacheDir, "editor-perf-recon-$runId.json")
        val plain = List(20_000) { if (it % 2 == 0) "plain paragraph $it" else "" }.joinToString("\n")
        val lines = List(20_000) { "plain line $it" }.joinToString("\n")
        val fixtures = listOf(
            Fixture("20000-lines-paragraphs", plain),
            Fixture("20000-lines-single-paragraph", lines),
            Fixture("20000-items-single-list", List(20_000) { "- plain item $it" }.joinToString("\n")),
            Fixture("20000-code-lines-single-fence", "```\n$lines\n```"),
        ).let {
            when (mode) {
                "bounded-followup" -> listOf(it[3])
                "post-fix-checkpoint" -> listOf(it[2], it[0], it[1], it[3])
                else -> it
            }
        }
        val results = JSONArray()
        val report = JSONObject().put("formatVersion", 1).put("runId", runId)
            .put("startedEpochMs", startedEpochMs).put("probeMode", mode).put("buildFingerprint", Build.FINGERPRINT)
            .put("model", Build.MODEL).put("device", Build.DEVICE).put("hardware", Build.HARDWARE)
            .put("sdk", Build.VERSION.SDK_INT).put("supportedAbis", JSONArray(Build.SUPPORTED_ABIS))
            .put("process64Bit", Process.is64Bit()).put("logicalCores", Runtime.getRuntime().availableProcessors())
            .put("thread", Thread.currentThread().name).put("wallBudgetSeconds", 120)
            .put("storageRoot", root.absolutePath)
            .put("measurement", "Public-call wall-time upper bound: Kotlin/FFI and engine, in-memory edits; explicit checkpoints time the Store markdown write; no pure engine CPU attribution")
            .put("warmup", "20 edits in separate tiny note; ")
            .put("limits", "No renderer/IME, scheduler100ms, process-kill or power-loss acceptance; phase-entry report writes outside timers affect between-phase conditions; profile/source/artifact attribution requires host receipt")
            .put("flushClock", "explicit checkpoint wall time: persist-or-park markdown write of the whole note; warm/jump are intentional unsaved batches; not timer scheduling proof")
            .put("fixtures", results)
        fun persist() {
            report.put("outcome", outcome).put("phase", phase).put("updatedEpochMs", System.currentTimeMillis())
            failure?.let { report.put("error", "${it.javaClass.name}: ${it.message}") }
            output.writeText(report.toString())
        }
        fun checkBudget() {
            if (System.nanoTime() >= deadline) {
                outcome = "budget-limited"
                error("Reconnaissance reached its declared 120 second wall budget; partial samples retained")
            }
        }
        println("EDITOR_PERF_RECON_REPORT=${output.absolutePath}")
        persist()
        try {
            NoteStore(root.absolutePath).use { store ->
                // Initialize shared JNI/binding paths before measuring each new note's first header.
                store.createNote("warmup", "", "plain")
                store.openEditor("warmup").use { warmup ->
                    repeat(20) { at ->
                        warmup.replaceUtf16Action(at.toULong(), EditorUtf16Range(0uL, 0uL),
                            listOf(120u.toUShort()), EditorInputAction.TYPING)
                    }
                    warmup.detach()
                }
                if (mode == "bounded-followup") {
                    phase = "huge-paragraph/projection-only-contrast"
                    checkBudget()
                    val pairs = JSONArray()
                    val diagnostic = JSONObject().put("fixtureSha256", sha256(lines))
                        .put("fixtureBytes", lines.toByteArray(Charsets.UTF_8).size).put("fixtureLines", 20_000)
                        .put("requestedPairs", 3).put("pairs", pairs)
                        .put("order", "full then one-byte, each pair; no forced GC; projection objects not retained between calls")
                        .put("purpose", "No edit, append or reparse; tiny still scans retained segments. Difference is not exact component attribution.")
                    report.put("projectionDiagnostic", diagnostic)
                    persist()
                    phase = "huge-paragraph/create-start"
                    persist()
                    val createStart = System.nanoTime()
                    store.createNote("projection-control", "", lines)
                    diagnostic.put("createNs", System.nanoTime() - createStart)
                    phase = "huge-paragraph/create-end"
                    persist()
                    phase = "huge-paragraph/open-start"
                    persist()
                    val openStart = System.nanoTime()
                    store.openEditor("projection-control").use { control ->
                        diagnostic.put("openNs", System.nanoTime() - openStart)
                        phase = "huge-paragraph/projection-only-contrast"
                        persist()
                        assertEquals(lines, control.displayText())
                        fun query(range: EditorByteRange, expected: String): JSONObject {
                            checkBudget()
                            phase = "huge-paragraph/project-${range.end - range.start}-bytes"
                            persist()
                            val started = System.nanoTime()
                            val projection = control.project(0uL, range)
                            val elapsed = System.nanoTime() - started
                            val row = JSONObject().put("ns", elapsed)
                                .put("textBytes", projection.text.toByteArray(Charsets.UTF_8).size)
                                .put("textSha256", sha256(projection.text)).put("correspondences", projection.correspondence.size)
                                .put("blocks", projection.blocks.size).put("runs", projection.runs.size)
                            diagnostic.put("lastQuery", row)
                            assertEquals(range, projection.range)
                            assertEquals(expected, projection.text)
                            return row
                        }
                        repeat(3) {
                            val full = query(EditorByteRange(0uL, lines.length.toULong()), lines)
                            val tiny = query(EditorByteRange(0uL, 1uL), "p")
                            pairs.put(JSONObject().put("full", full).put("tiny", tiny))
                            persist()
                        }
                        assertEquals(0uL, control.revision())
                        assertEquals(0uL, control.saveStatus().revision)
                        control.detach()
                    }
                }
                for ((index, fixture) in fixtures.withIndex()) {
                    checkBudget()
                    phase = "${fixture.name}/create-start"
                    val metric = JSONObject().put("fixture", fixture.name)
                        .put("fixtureSha256", sha256(fixture.source))
                        .put("fixtureBytes", fixture.source.toByteArray(Charsets.UTF_8).size)
                        .put("fixtureLines", fixture.source.count { it == '\n' } + 1)
                        .put("samplesPerWarmPhase", samples).put("appendFlushPairs", flushPairs)
                    results.put(metric)
                    persist()
                    val id = "probe-$index"
                    val createStart = System.nanoTime()
                    store.createNote(id, "", fixture.source)
                    metric.put("createNs", System.nanoTime() - createStart)
                    phase = "${fixture.name}/create-end"
                    persist()
                    phase = "${fixture.name}/open-start"
                    persist()
                    val openStart = System.nanoTime()
                    val session = store.openEditor(id)
                    metric.put("openNs", System.nanoTime() - openStart)
                    phase = "${fixture.name}/open-end"
                    persist()
                    var finalSource = ""
                    session.use { s ->
                        val shown = s.displayText()
                        assertTrue(shown.length > 2)
                        var length = shown.length.toULong()
                        var revision = s.revision()
                        var saved = 0uL
                        var lastChange: EditorViewChange? = null
                        var lastFlush: EditorSaveStatus? = null
                        var previousSaved = 0uL
                        val flushes = JSONArray()
                        val returned = JSONArray()
                        metric.put("flushes", flushes).put("returnedProjections", returned)
                        val parsed = JSONArray()
                        val materialized = JSONArray()
                        metric.put("initialDisplayUnits", shown.length)
                            .put("parsedSourceBytes", parsed).put("materializedSourceBytes", materialized)
                        fun edit(at: ULong): Long {
                            checkBudget()
                            val started = System.nanoTime()
                            val change = s.replaceUtf16Action(revision, EditorUtf16Range(at, at),
                                listOf(120u.toUShort()), EditorInputAction.TYPING)
                            val elapsed = System.nanoTime() - started
                            assertEquals(revision + 1uL, change.revision)
                            revision = change.revision
                            length++
                            lastChange = change
                            return elapsed
                        }
                        fun recordWork() {
                            val change = checkNotNull(lastChange)
                            parsed.put(change.parsedSourceBytes.toLong())
                            materialized.put(change.materializedSourceBytes.toLong())
                        }
                        fun recordProjection(label: String) {
                            val change = checkNotNull(lastChange)
                            val projection = change.projection
                            returned.put(JSONObject().put("sample", label).put("revision", change.revision.toLong())
                                .put("textBytes", projection.text.toByteArray(Charsets.UTF_8).size)
                                .put("runs", projection.runs.size).put("correspondences", projection.correspondence.size)
                                .put("blocks", projection.blocks.size).put("links", projection.links.size))
                        }
                        fun flush(): Long {
                            checkBudget()
                            check(revision > saved) { "Save sample requires a fresh unsaved revision" }
                            previousSaved = saved
                            val started = System.nanoTime()
                            s.checkpoint()
                            val elapsed = System.nanoTime() - started
                            val status = s.saveStatus()
                            assertEquals(revision, status.revision)
                            assertEquals(revision, status.saved)
                            saved = status.saved
                            lastFlush = status
                            return elapsed
                        }
                        fun recordFlush(label: String, immediate: Boolean, elapsed: Long) {
                            val status = checkNotNull(lastFlush)
                            flushes.put(JSONObject().put("sample", label).put("immediateAfterOneAppend", immediate)
                                .put("previousSaved", previousSaved.toLong()).put("revision", status.revision.toLong())
                                .put("saved", status.saved.toLong()).put("flushNs", elapsed))
                        }
                        // The first edit of a fresh session; its checkpoint is the first markdown write.
                        phase = "${fixture.name}/cold-first-append"
                        persist()
                        metric.put("coldFirstAppendNs", edit(0uL))
                        val coldFlush = flush()
                        metric.put("coldImmediateExplicitFlushNs", coldFlush)
                        recordFlush("cold", true, coldFlush)
                        recordWork()
                        recordProjection("cold")
                        persist()
                        phase = "${fixture.name}/warm-typing"
                        persist()
                        val warm = JSONArray()
                        metric.put("warmTypingNs", warm)
                        var caret = 1uL
                        repeat(samples) { warm.put(edit(caret)); recordWork(); caret++ }
                        val warmFlush = flush()
                        metric.put("warmBatchExplicitFlushNs", warmFlush)
                        recordFlush("warm-batch", false, warmFlush)
                        recordProjection("warm-batch-last")
                        persist()
                        phase = "${fixture.name}/distant-jumps"
                        persist()
                        val jumpSelection = JSONArray()
                        val jumpEdit = JSONArray()
                        metric.put("jumpSelectionNs", jumpSelection).put("firstKeyAfterJumpNs", jumpEdit)
                        repeat(samples) { at ->
                            checkBudget()
                            val point = if (at % 2 == 0) length - 1uL else 0uL
                            val started = System.nanoTime()
                            s.selectUtf16(revision, EditorUtf16Range(point, point))
                            jumpSelection.put(System.nanoTime() - started)
                            jumpEdit.put(edit(point))
                            recordWork()
                        }
                        val jumpFlush = flush()
                        metric.put("jumpBatchExplicitFlushNs", jumpFlush)
                        recordFlush("jump-batch", false, jumpFlush)
                        recordProjection("jump-batch-last")
                        persist()
                        phase = "${fixture.name}/append-flush-pairs"
                        persist()
                        val pairAppend = JSONArray()
                        val pairFlush = JSONArray()
                        val pairTotal = JSONArray()
                        metric.put("pairedAppendNs", pairAppend).put("pairedExplicitFlushNs", pairFlush)
                            .put("appendThroughExplicitFlushNs", pairTotal)
                        repeat(flushPairs) { pair ->
                            val started = System.nanoTime()
                            pairAppend.put(edit(0uL))
                            val flushNs = flush()
                            pairTotal.put(System.nanoTime() - started)
                            pairFlush.put(flushNs)
                            recordFlush("pair-$pair", true, flushNs)
                            recordWork()
                            recordProjection("pair-$pair")
                        }
                        persist()
                        phase = "${fixture.name}/sanity-and-reopen"
                        persist()
                        checkBudget()
                        val expectedDisplay = "x".repeat(1 + samples + samples / 2 + flushPairs) + shown.dropLast(1) +
                            "x".repeat(samples / 2) + shown.takeLast(1)
                        val observedDisplay = s.displayText()
                        finalSource = s.sourceText()
                        metric.put("finalSourceSha256", sha256(finalSource))
                        try {
                            assertEquals(expectedDisplay, observedDisplay)
                            assertEquals(fixture.source.toByteArray(Charsets.UTF_8).size + 1 + 2 * samples + flushPairs,
                                finalSource.toByteArray(Charsets.UTF_8).size)
                        } catch (error: AssertionError) {
                            // Generated synthetic text only; retain a failed probe premise for diagnosis.
                            metric.put("sanityOpeningSource", fixture.source).put("sanityObservedSource", finalSource)
                                .put("sanityExpectedDisplay", expectedDisplay).put("sanityObservedDisplay", observedDisplay)
                            throw error
                        }
                        s.detach()
                    }
                    assertEquals(finalSource, store.read(id))
                    store.openEditor(id).use { reopened ->
                        assertEquals(finalSource, reopened.sourceText())
                        reopened.detach()
                    }
                }
            }
            checkBudget()
            outcome = "completed"
        } catch (error: Throwable) {
            failure = error
            if (outcome != "budget-limited") outcome = "failed"
            throw error
        } finally {
            try { persist() } finally { root.deleteRecursively() }
            println("EDITOR_PERF_RECON_REPORT=${output.absolutePath}")
        }
    }

    private fun sha256(text: String) = MessageDigest.getInstance("SHA-256")
        .digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
}

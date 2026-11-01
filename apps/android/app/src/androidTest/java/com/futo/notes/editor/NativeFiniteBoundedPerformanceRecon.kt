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
import uniffi.futo_notes_ffi.*

/** Opt-in finite architecture reconnaissance, sharing the full probe's vault/report/budget contract. */
internal fun recordFiniteBoundedRecon() {
    val args = InstrumentationRegistry.getArguments()
    assumeTrue("Native performance reconnaissance requires explicit editorPerformanceRecon=true",
        args.getString("editorPerformanceRecon") == "true")
    require(args.getString("editorPerformanceMode") == "finite-bounded-checkpoint")
    val requestedRunId = requireNotNull(args.getString("editorPerformanceRunId"))
    val runId = UUID.fromString(requestedRunId).toString()
    require(runId == requestedRunId) { "A canonical probe UUID is required" }
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = File(context.cacheDir, "editor-perf-vault-$runId")
    check(root.mkdirs())
    val output = File(context.cacheDir, "editor-perf-recon-$runId.json")
    val deadline = System.nanoTime() + 120_000_000_000L
    var phase = "setup"
    var outcome = "running"
    var failure: Throwable? = null
    val results = JSONArray()
    val report = JSONObject().put("formatVersion", 1).put("runId", runId)
        .put("startedEpochMs", System.currentTimeMillis()).put("probeMode", "finite-bounded-checkpoint")
        .put("buildFingerprint", Build.FINGERPRINT).put("model", Build.MODEL)
        .put("device", Build.DEVICE).put("hardware", Build.HARDWARE).put("sdk", Build.VERSION.SDK_INT)
        .put("supportedAbis", JSONArray(Build.SUPPORTED_ABIS)).put("process64Bit", Process.is64Bit())
        .put("logicalCores", Runtime.getRuntime().availableProcessors()).put("thread", Thread.currentThread().name)
        .put("wallBudgetSeconds", 120).put("storageRoot", root.absolutePath).put("fixtures", results)
        .put("nativeApi", "NativeBoundedEditorSession; explicit proportional entry and full handoff")
        .put("measurement", "Public-call wall time includes Kotlin/JNI/UniFFI, engine and real Store acceptance; not isolated parser CPU or append IO")
        .put("warmup", "20 full-API edits in separate tiny note; cold is first accepted bounded edit after entry")
        .put("limits", "Early architecture feedback only; no #316 acceptance, p95 gate, renderer/IME, timer scheduler, process-kill or power-loss proof. Entry/source copy/full handoff are proportional. Between-phase JSON writes, deferred oracle replay and JVM allocations affect conditions; no forced GC. Cooperative budget checks cannot interrupt synchronous calls.")
        .put("flushClock", "Rust completion minus oldest deadline, saturated at zero; positive is lateness, zero hides slack. Immediate flush and deliberate unflushed batches do not prove scheduling or healthy-storage 100ms durability.")
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
        val plain = List(20_000) { if (it % 2 == 0) "plain paragraph $it" else "" }.joinToString("\n")
        val lines = List(20_000) { "plain line $it" }.joinToString("\n")
        val fixtures = listOf("20000-code-lines-single-fence" to "```\n$lines\n```",
            "short-fence-20000-lines-independent-paragraphs" to "```\nplain line 0\nplain line 1\n```\n\n$plain")
        NoteStore(root.absolutePath).use { store ->
            store.createNote("warmup", "", "plain")
            store.openEditor("warmup").use { warmup ->
                repeat(20) { at -> warmup.replaceUtf16Action(at.toULong(), EditorUtf16Range(0uL, 0uL),
                    listOf(120u.toUShort()), EditorInputAction.TYPING) }
                warmup.flushRecovery()
                warmup.detach()
            }
            for ((index, fixture) in fixtures.withIndex()) {
                val (name, source) = fixture
                checkBudget()
                val metric = JSONObject().put("fixture", name).put("fixtureSha256", finiteSha256(source))
                    .put("fixtureBytes", source.toByteArray(Charsets.UTF_8).size)
                    .put("fixtureLines", source.count { it == '\n' } + 1)
                results.put(metric)
                phase = "$name/create-start"
                persist()
                val id = "probe-$index"
                val createStart = System.nanoTime()
                store.createNote(id, "", source)
                metric.put("createNs", JSONArray().put(System.nanoTime() - createStart))
                phase = "$name/open-start"
                persist()
                checkBudget()
                val openStart = System.nanoTime()
                val full = store.openEditor(id)
                metric.put("openNs", JSONArray().put(System.nanoTime() - openStart))
                val finalSource = recordFiniteBoundedFixture(store, full, name, source, metric,
                    { label -> phase = "$name/$label"; persist() }, ::checkBudget, ::persist)
                phase = "$name/reopen-checkpoint-readback"
                persist()
                checkBudget()
                store.openEditor(id).use { recovered ->
                    assertEquals(finalSource, recovered.sourceText())
                    recovered.checkpoint()
                    assertEquals(finalSource, store.read(id))
                    recovered.detach()
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

/** This finite consumer retains deltas; it replays the whole-view oracle only after timing. */
private fun recordFiniteBoundedFixture(store: NoteStore, full: NativeEditorSession,
    name: String, source: String, metric: JSONObject, stage: (String) -> Unit,
    checkBudget: () -> Unit, persist: () -> Unit): String = full.use {
    val suffix = name == "short-fence-20000-lines-independent-paragraphs"
    val shown = full.displayText() // Initial display and UTF-8 anchors precede bounded timing.
    assertTrue(shown.all { it.code < 128 })
    var farCode = (shown.indexOf(if (suffix) "plain line 1" else "plain line 19999") + 2).toULong()
    var farUnit = if (suffix) (shown.lastIndexOf("plain paragraph 19998") + 2).toULong() else 0uL
    val displayDeltas = mutableListOf<Pair<EditorByteRange, String>>()
    val sourceDeltas = mutableListOf<Pair<EditorSourceByteRange, String>>()
    val revisions = JSONArray()
    val flushes = JSONArray()
    metric.put("samplesPerWarmPhase", 20).put("appendFlushPairs", 10)
        .put("initialDisplayBytes", shown.length).put("acceptedRevisions", revisions).put("flushes", flushes)
        .put("fixtureScope", if (suffix) "Short closed top-level fence; suffix has 20000 physical lines, 10000 independent paragraphs, at most 64 source bytes per unit"
            else "Retained closed top-level fence with 20000 code lines")
        .put("proportionalPhases", "entryPreparationNs, acceptedSourceCopyNs, fullMaterializationNs")
    fun samples(name: String) = JSONArray().also { metric.put(name, it) }
    fun single(name: String, ns: Long) { samples(name).put(ns) }
    stage("proportional-entry")
    checkBudget()
    val entryStart = System.nanoTime()
    val bounded = full.intoBounded(0uL, 283uL, 1uL)
    single("entryPreparationNs", System.nanoTime() - entryStart)
    bounded.use { b ->
        var cursor = b.cursor()
        val preparation = b.preparationWork()
        metric.put("preparationInspectedSourceBytes", preparation.work.inspectedSourceBytes.toLong())
            .put("preparationMetadataItems", preparation.work.metadataItems.toLong())
            .put("preparationConversionRecords", preparation.conversion.records.toLong())
        var continuation: EditorProjectionContinuation? = null
        var durable = 0uL
        fun delta(range: EditorByteRange, inserted: String) {
            assertTrue(inserted.all { it.code < 128 })
            displayDeltas.add(range to inserted)
            val shift = inserted.length.toLong() - (range.end - range.start).toLong()
            if (farCode >= range.end) farCode = (farCode.toLong() + shift).toULong()
            if (suffix && farUnit >= range.end) farUnit = (farUnit.toLong() + shift).toULong()
        }
        fun accepted(change: EditorBoundedChange, at: ULong) {
            assertEquals(cursor, change.previous)
            assertEquals(cursor.revision + 1uL, change.cursor.revision)
            assertEquals(EditorByteRange(at, at), change.range)
            assertEquals(EditorByteRange(at + 1uL, at + 1uL), change.selection)
            assertEquals(change.sourceChange.range.start, change.sourceChange.range.end)
            assertEquals("x", change.inserted)
            assertEquals(1uL, change.sourceChange.insertedBytes)
            assertEquals(0uL, change.work.parsedSourceBytes)
            assertTrue(change.conversion.records > 0uL)
            delta(change.range, change.inserted)
            sourceDeltas.add(change.sourceChange.range to "x")
            cursor = change.cursor
            continuation = change.continuation
            revisions.put(cursor.revision.toLong())
            val status = b.recoveryStatus()
            assertEquals(cursor.revision, status.accepted)
            assertFalse(status.paused)
        }
        fun progress(change: EditorBoundedProgressChange) {
            assertEquals(cursor, change.previous)
            assertEquals(0uL, change.work.parsedSourceBytes)
            assertTrue(change.conversion.records > 0uL)
            delta(change.range, change.inserted)
            change.sourceChange?.let { source ->
                assertEquals(cursor.revision + 1uL, change.cursor.revision)
                assertEquals(0uL, source.insertedBytes)
                sourceDeltas.add(source.range to "")
                revisions.put(change.cursor.revision.toLong())
            } ?: assertEquals(cursor.revision, change.cursor.revision)
            cursor = change.cursor
            continuation = change.continuation
            val status = b.recoveryStatus()
            assertEquals(cursor.revision, status.accepted)
            assertFalse(status.paused)
        }
        fun frame(value: EditorBoundedProgress): EditorByteRange =
            when (value) {
                is EditorBoundedProgress.Change -> {
                    progress(value.change)
                    value.change.selection
                }
                is EditorBoundedProgress.Status -> {
                    assertEquals(cursor, value.status.previous)
                    assertEquals(cursor.revision, value.status.cursor.revision)
                    cursor = value.status.cursor
                    continuation = value.status.continuation
                    value.status.selection
                }
            }
        fun edit(at: ULong): Long {
            checkBudget()
            val started = System.nanoTime()
            val change = b.insertLiteral(cursor, at, 120u)
            val elapsed = System.nanoTime() - started
            accepted(change, at)
            return elapsed
        }
        fun recordFlush(status: EditorRecoveryStatus, ns: Long, delay: Long?, observation: String) {
            assertTrue(cursor.revision > durable)
            assertEquals(cursor.revision, status.accepted)
            assertEquals(cursor.revision, status.durable)
            assertFalse(status.paused)
            assertNull(b.recoveryFlushDelay())
            flushes.put(JSONObject().put("previousDurable", durable.toLong())
                .put("accepted", status.accepted.toLong()).put("durable", status.durable.toLong())
                .put("paused", status.paused).put("flushNs", ns)
                .put("remainingDelayNs", delay ?: JSONObject.NULL).put("remainingDelayObservation", observation)
                .put("lastFlushLatenessNs", checkNotNull(status.lastFlushLateness).toNanos()))
            durable = status.durable
        }
        fun flush(name: String) {
            checkBudget()
            val delay = checkNotNull(b.recoveryFlushDelay()).toNanos()
            val started = System.nanoTime()
            val status = b.flushRecovery()
            val elapsed = System.nanoTime() - started
            single(name, elapsed)
            recordFlush(status, elapsed, delay, "before explicit flush")
        }
        stage("cold-first-bounded-edit")
        single("coldFirstAppendNs", edit(1uL))
        flush("coldImmediateExplicitFlushNs")
        persist()
        stage("warm-typing")
        val warm = samples("warmTypingNs")
        repeat(20) { warm.put(edit((it + 2).toULong())) }
        flush("warmBatchExplicitFlushNs")
        persist()
        stage("far-near-selection-and-first-key")
        val selections = samples("jumpSelectionNs")
        val keys = samples("firstKeyAfterJumpNs")
        repeat(20) { index ->
            checkBudget()
            val point = if (index % 2 == 0) farCode else 1uL
            val started = System.nanoTime()
            val selected = b.selectBounded(cursor, EditorByteRange(point, point), EditorAffinity.BACKWARD)
            selections.put(System.nanoTime() - started)
            val selection = frame(selected)
            keys.put(edit(selection.start))
        }
        flush("jumpBatchExplicitFlushNs")
        persist()
        stage("append-flush-pairs")
        val append = samples("pairedAppendNs")
        val explicit = samples("pairedExplicitFlushNs")
        val total = samples("appendThroughExplicitFlushNs")
        repeat(10) {
            checkBudget()
            // No query, assertion, JSON write or oracle splice inside this enclosing timer.
            val started = System.nanoTime()
            val change = b.insertLiteral(cursor, 1uL, 120u)
            val appended = System.nanoTime()
            val status = b.flushRecovery()
            val flushed = System.nanoTime()
            append.put(appended - started)
            explicit.put(flushed - appended)
            total.put(flushed - started)
            accepted(change, 1uL)
            recordFlush(status, flushed - appended, null, "not queried inside append-through-flush timer")
        }
        persist()
        if (suffix) {
            stage("remove-closer")
            checkBudget()
            val started = System.nanoTime()
            val removed = b.removeFenceCloser(cursor)
            single("removeCloserNs", System.nanoTime() - started)
            progress(removed)
            stage("first-far-unit-selection-and-key")
            checkBudget()
            val point = farUnit
            val selectStart = System.nanoTime()
            val selected = b.selectBounded(cursor, EditorByteRange(point, point), EditorAffinity.BACKWARD)
            single("firstFarUnitSelectionNs", System.nanoTime() - selectStart)
            // Selection can itself convert the prioritized unit and invalidate the prior job.
            val selection = frame(selected)
            single("firstFarUnitKeyNs", edit(selection.start))
            persist()
            stage("progress-frontier")
            val steps = samples("continuationNs")
            metric.put("continuationFrameCount", 0)
                .put("continuationCompletionClock", "Cumulative wall time includes between-call validation and periodic report persistence")
            val completionStart = System.nanoTime()
            while (continuation != null) {
                checkBudget()
                val job = checkNotNull(continuation)
                val stepStart = System.nanoTime()
                val next = b.continueProjection(job)
                steps.put(System.nanoTime() - stepStart)
                frame(next)
                metric.put("continuationFrameCount", steps.length())
                if (steps.length() % 128 == 0) persist()
            }
            single("continuationCompletionNs", System.nanoTime() - completionStart)
            flush("frontierBatchExplicitFlushNs")
            persist()
        }
        stage("proportional-source-copy")
        checkBudget()
        val copyStart = System.nanoTime()
        val copy = b.acceptedSource()
        single("acceptedSourceCopyNs", System.nanoTime() - copyStart)
        assertEquals(cursor.revision, copy.revision)
        assertEquals(cursor.revision, copy.recovery.accepted)
        assertEquals(durable, copy.recovery.durable)
        assertFalse(copy.resetRequired || copy.deleted || copy.recovery.paused)
        val expected = StringBuilder(source)
        for ((range, inserted) in sourceDeltas) expected.replace(range.start.toInt(), range.end.toInt(), inserted)
        assertEquals(expected.toString(), copy.source)
        val view = StringBuilder(shown)
        for ((range, inserted) in displayDeltas) view.replace(range.start.toInt(), range.end.toInt(), inserted)
        stage("proportional-full-handoff")
        checkBudget()
        val handoffStart = System.nanoTime()
        val handoff = b.intoFull()
        single("fullMaterializationNs", System.nanoTime() - handoffStart)
        handoff.session.use { restored ->
            stage("canonical-oracle")
            assertEquals(copy.source, restored.sourceText())
            assertEquals(view.toString(), restored.displayText())
            store.createNote("oracle-${name}", "", copy.source)
            store.openEditor("oracle-${name}").use { oracle ->
                val range = EditorByteRange(0uL, view.length.toULong())
                assertEquals(oracle.project(0uL, range).copy(revision = cursor.revision),
                    restored.project(cursor.revision, range))
                oracle.detach()
            }
            restored.detach()
        }
        metric.put("finalSourceSha256", finiteSha256(copy.source))
        val summaries = JSONObject()
        for (key in metric.keys().asSequence().toList()) {
            val array = metric.optJSONArray(key) ?: continue
            if (!key.endsWith("Ns") || array.length() == 0) continue
            val sorted = (0 until array.length()).map { array.getLong(it) }.sorted()
            val median = if (sorted.size % 2 == 0)
                sorted[sorted.size / 2 - 1] / 2.0 + sorted[sorted.size / 2] / 2.0 else sorted[sorted.size / 2].toDouble()
            summaries.put(key, JSONObject().put("samples", sorted.size).put("min", sorted.first())
                .put("median", median).put("max", sorted.last()))
        }
        metric.put("timingSummaryNs", summaries)
        persist()
        copy.source
    }
}

private fun finiteSha256(text: String) = MessageDigest.getInstance("SHA-256")
    .digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }

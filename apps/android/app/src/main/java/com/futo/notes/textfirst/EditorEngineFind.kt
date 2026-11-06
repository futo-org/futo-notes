package com.futo.notes.textfirst

import uniffi.futo_notes_ffi.EditorByteRange
import uniffi.futo_notes_ffi.EditorFindReport
import uniffi.futo_notes_ffi.EditorSessionException
import uniffi.futo_notes_ffi.NativeEditorSession
import uniffi.futo_notes_ffi.editorFindScan

// Find over the note. Matching, stepping, table barriers and rebasing are the
// canonical editor's; this file only converts its display byte ranges to the
// view's UTF-16 and lands on a match through the shared display selection.
// Find never edits source, so it adds no Undo action and no recovery record.

private const val FIND_REFRESH_MS = 150L

/** Editor-thread find bookkeeping; the matches themselves live in the session. */
internal class FindEngineState(refresh: () -> Unit) {
    var open = false
    /** Whether a step has already landed on the current match since the query last changed. */
    var landed = false
    var scanning = false
    val refresh = Runnable { refresh() }
    val executor: java.util.concurrent.ExecutorService by lazy { java.util.concurrent.Executors.newSingleThreadExecutor { Thread(it, "futo-find-scan") } }

    fun release(handler: android.os.Handler) {
        handler.removeCallbacks(refresh)
        open = false
        if (!executor.isShutdown) executor.shutdown()
    }
}

/** The result of an explicit find command, then delivered to the sink. Editor thread. */
internal fun EditorEngine.findCommand(done: (FindSnapshot?) -> Unit, block: (NativeEditorSession) -> Pair<EditorFindReport, Boolean>) {
    val posted = handler.post {
        var result: FindSnapshot? = null
        try {
            val s = session
            if (!closed && s != null && storageGate?.isMigrationStarted != true) {
                // Matches and their reveal can lie anywhere in the note.
                finishStreaming()
                val (report, reveal) = block(s)
                find.open = report.open
                result = snapshot(s, report, reveal)
                ui.post { sink.onFind(result) }
            }
        } catch (e: EditorSessionException) {
            handleFailure(e)
        } finally { ui.post { done(result) } }
    }
    if (!posted) ui.post { done(null) }
}

internal fun EditorEngine.findSetQuery(query: String, done: (FindSnapshot?) -> Unit) = findCommand(done) { s ->
    find.landed = false
    val report = s.findSetQuery(rev, query)
    report to (report.reveal != null)
}

/** The first step lands on the current match; later ones move from it. Refused during composition. */
internal fun EditorEngine.findStep(forward: Boolean, done: (FindSnapshot?) -> Unit) = findCommand(done) { s ->
    if (mirror.overlay != null) return@findCommand s.findReport() to false
    val report = if (find.landed) s.findStep(rev, forward) else s.findReport()
    val landing = if (find.landed) report.reveal else report.currentRange
    if (landing != null) {
        showDisplayRange(mirror.toUtf16(landing.start.toInt()), mirror.toUtf16(landing.end.toInt()))
        find.landed = true
    }
    report to (landing != null)
}

internal fun EditorEngine.findClose(done: (FindSnapshot?) -> Unit) = findCommand(done) { s ->
    find.landed = false
    handler.removeCallbacks(find.refresh)
    s.findClose() to false
}

/** Input only logs edit windows; matches rebase on read and a settled rescan replaces stale ones. */
internal fun EditorEngine.scheduleFindRefresh() {
    if (!find.open || closed) return
    handler.removeCallbacks(find.refresh)
    handler.postDelayed(find.refresh, FIND_REFRESH_MS)
}

internal fun EditorEngine.refreshFind() {
    val s = session ?: return
    if (!find.open || closed || mirror.overlay != null) return
    try {
        val report = s.findReport()
        if (report.stale && !find.scanning) {
            val request = s.findScanRequest()
            if (request != null) {
                find.scanning = true
                find.executor.execute {
                    val result = try { editorFindScan(request) } catch (e: Exception) { null }
                    handler.post {
                        find.scanning = false
                        val live = session
                        if (closed || live == null || result == null) return@post
                        try {
                            live.findApplyScan(result)?.let { applied ->
                                if (mirror.overlay == null) { val snap = snapshot(live, applied, false); ui.post { sink.onFind(snap) } }
                            }
                        } catch (e: EditorSessionException) { handleFailure(e) }
                    }
                }
            }
        }
        val snap = snapshot(s, report, false)
        ui.post { sink.onFind(snap) }
    } catch (e: EditorSessionException) { handleFailure(e) }
}

private fun EditorEngine.snapshot(s: NativeEditorSession, report: EditorFindReport, reveal: Boolean): FindSnapshot {
    // Matches are drawn in the mirror's coordinates; while a composition overlays
    // it they would be off by the marked text, so highlights wait for its end.
    val matches = if (!report.open || report.total == 0uL || mirror.overlay != null) emptyList() else
        s.findMatches(rev, EditorByteRange(0u, mirror.utf8Length.toULong())).map { mirror.toUtf16(it.start.toInt()) to mirror.toUtf16(it.end.toInt()) }
    val target = if (reveal) (report.currentRange ?: report.reveal) else null
    return FindSnapshot(
        open = report.open, query = report.query, total = report.total.toInt(), current = report.current.toInt(),
        stale = report.stale, matches = matches,
        reveal = target?.let { mirror.toUtf16(it.start.toInt()) to mirror.toUtf16(it.end.toInt()) },
    )
}

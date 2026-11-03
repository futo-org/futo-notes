package com.futo.notes.textfirst

import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.futo.notes.storage.StorageMigrationGate
import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.EditorByteRange
import uniffi.futo_notes_ffi.EditorInlineFormat
import uniffi.futo_notes_ffi.EditorInputAction
import uniffi.futo_notes_ffi.EditorParagraphKey
import uniffi.futo_notes_ffi.EditorProjection
import uniffi.futo_notes_ffi.EditorSessionException
import uniffi.futo_notes_ffi.EditorUtf16Range
import uniffi.futo_notes_ffi.EditorViewChange
import uniffi.futo_notes_ffi.FlushDraftResult
import uniffi.futo_notes_ffi.NativeEditorSession
import uniffi.futo_notes_ffi.NoteStore

internal interface EngineSink {
    fun onUpdate(update: UiUpdate)
    fun onCaretState(state: CaretState)
    /** A Markdown save landed; [noteId] is the attachment's identity after it (a park moves it). */
    fun onCheckpoint(result: FlushDraftResult, noteId: String)
    /** A failed save does not pause input: the Store retries it on its own schedule. */
    fun onFailure(error: EditorSessionException)
    /** The keyboard's idea of the text is now wrong (a refused edit); restart its connection. */
    fun onImeReset()
}

/**
 * The editor thread. It owns the [NativeEditorSession] (Store and FFI calls
 * block, so never the UI thread — host contract §3), receives keyboard calls
 * directly (the input connection's handler is this thread's), and keeps
 * [text], the display text exactly as the keyboard should see it, including
 * any marked composition. Each accepted engine change is applied here first
 * and then posted to the view in order.
 *
 * Coordinates: everything here is display UTF-16 units of [text]. Engine byte
 * ranges are converted through [index] at the edge.
 */
internal class EditorEngine(
    /** Resolved on the editor thread: the first touch of the store loads the native library. */
    internal val store: () -> NoteStore,
    internal val noteId: String,
    internal val sink: EngineSink,
    /** Debug/test: compare the mirror with the engine's display after every change. */
    private val verifyMirror: Boolean = false,
    internal val storageGate: StorageMigrationGate? = null,
) {
    private val thread = HandlerThread("futo-editor", Process.THREAD_PRIORITY_DISPLAY).apply { start() }
    val handler = Handler(thread.looper)
    internal val ui = Handler(Looper.getMainLooper())

    // ---- editor-thread state ----
    internal var session: NativeEditorSession? = null
    internal var fast: FastSession? = null
    internal var rev: ULong = 0u
    internal val mirror = DisplayMirror()

    /** The keyboard's view, read by the input connection on this thread. */
    val text: CharSequence get() = mirror.text
    val selStart: Int get() = mirror.selStart
    val selEnd: Int get() = mirror.selEnd
    internal var seq = 0
    internal var saveArmed = false
    internal var closed = false
    private var inputStartNanos = 0L
    private var engineNanos = 0L
    /** The last change's projection; the caret state reads its block from it. */
    internal var lastProjection: EditorProjection? = null
    /** The empty item (UTF-16 offset) whose Indent the engine is holding. */
    private var heldIndentAt: Int? = null

    /** Read on the UI thread when the keyboard connects. */
    @Volatile var publishedSelection = 0L
        private set


    // ---- view and toolbar (posted from the UI thread) ----

    /** A selection the view made (touch, handles, arrow keys) against update [viewSeq]. */
    fun viewSelection(viewSeq: Int, start: Int, end: Int) = handler.post {
        if (viewSeq != seq || closed) return@post
        if (start == mirror.selStart && end == mirror.selEnd) return@post
        if (mirror.overlay != null) {
            // The keyboard ends its own composition when the caret moves; keep
            // the pinned marked range intact until it does.
            mirror.selStart = start; mirror.selEnd = end; publishSelection(); return@post
        }
        guarded { select(start, end, fromView = true) }
    }

    fun toggleFormat(format: EditorInlineFormat) = command {
        if (mirror.overlay != null) commitComposition(null)
        session?.toggleFormat(rev, format)?.let(::accept)
    }

    fun blockCommand(command: EditorBlockCommand) = command {
        if (mirror.overlay != null) commitComposition(null)
        session?.blockCommandUtf16(rev, EditorUtf16Range(mirror.selStart.toULong(), mirror.selEnd.toULong()), command)?.let(::accept)
    }

    fun toggleTaskAt(offset: Int) = command {
        if (mirror.overlay != null) commitComposition(null)
        val s = session ?: return@command
        val keepStart = mirror.selStart; val keepEnd = mirror.selEnd
        val change = s.blockCommandUtf16(rev, EditorUtf16Range(offset.toULong(), offset.toULong()), EditorBlockCommand.ToggleTask)
        if (change != null) accept(change) else if (keepStart != mirror.selStart || keepEnd != mirror.selEnd) postUpdate(emptyList(), emptyList())
    }

    fun undo() = command {
        if (mirror.overlay != null) commitComposition(null)
        session?.undo(rev)?.let(::accept)
    }

    fun redo() = command {
        if (mirror.overlay != null) commitComposition(null)
        session?.redo(rev)?.let(::accept)
    }

    fun paste(markdown: String) = command {
        if (mirror.overlay != null) commitComposition(null)
        session?.pasteMarkdown(rev, mirror.byteRange(mirror.selStart, mirror.selEnd), markdown)?.let(::accept)
    }

    fun copy(cut: Boolean, deliver: (String) -> Unit) = command {
        if (mirror.overlay != null) commitComposition(null)
        val s = session ?: return@command
        if (mirror.selStart == mirror.selEnd) return@command
        val markdown = if (cut) {
            val result = s.cutMarkdown(rev, mirror.byteRange(mirror.selStart, mirror.selEnd))
            result.change?.let(::accept)
            result.markdown
        } else {
            s.copyMarkdown(rev, mirror.byteRange(mirror.selStart, mirror.selEnd))
        }
        ui.post { deliver(markdown) }
    }

    fun selectAll() = command { select(0, mirror.text.length, fromView = false) }

    /** A selection the host chooses (restoring the caret after a reload). */
    fun hostSelect(start: Int, end: Int) = command { select(start, end, fromView = false) }

    /** Begin an asynchronous image insertion; the claim goes back to [insertImage]. */
    fun imageClaim(deliver: (ULong?) -> Unit) {
        val posted = handler.post {
            var claim: ULong? = null
            try {
                if (!closed && session != null && storageGate?.isMigrationStarted != true) {
                    claim = session?.imageClaim()
                }
            } catch (e: EditorSessionException) {
                handleFailure(e)
            } finally {
                ui.post { deliver(claim) }
            }
        }
        if (!posted) ui.post { deliver(null) }
    }

    fun insertImage(claim: ULong, reference: String, done: (Boolean) -> Unit) {
        // This command holds a vault attachment operation open until its answer.
        // Every path, including stale/deleted sessions and a retired thread,
        // must answer; guarded() alone reports errors without a completion.
        val posted = handler.post {
            var inserted = false
            try {
                if (!closed && session != null && storageGate?.isMigrationStarted != true) {
                    if (mirror.overlay != null) commitComposition(null)
                    val change = session?.insertImage(rev, claim, reference, "")
                    if (change != null) {
                        inserted = true
                        accept(change)
                    }
                }
            } catch (e: EditorSessionException) {
                handleFailure(e)
            } finally {
                ui.post { done(inserted) }
            }
        }
        if (!posted) ui.post { done(false) }
    }

    /** Own-action changes (a relink after rename) the Store queued for this session. */
    fun drainCoordinatedChanges() = command {
        val s = session ?: return@command
        for (change in s.takeCoordinatedChanges()) {
            if (change.previousRevision != rev) {
                Log.w(TAG, "coordinated change ${change.previousRevision}->${change.revision} at $rev; reloading view")
                reloadFromEngine()
                return@command
            }
            accept(change)
        }
    }

    /**
     * Save the draft as Markdown now, ahead of the debounce (on pause). [done]
     * runs on the UI thread with the result, or null when nothing was unsaved
     * or the save failed (reported through the sink).
     */
    fun checkpoint(done: ((FlushDraftResult?) -> Unit)? = null) = handler.post {
        val result = if (closed || session == null) null else save(force = true)
        if (done != null) ui.post { done(result) }
    }

    /** The current exact source, for the screen's rename/draft paths. */
    fun sourceText(done: (String?) -> Unit) = handler.post {
        val source = try { session?.sourceText() } catch (e: EditorSessionException) { null }
        ui.post { done(source) }
    }

    /** Save before releasing. A failed detach leaves the exact session editable and retryable. */
    fun close(done: ((FlushDraftResult?) -> Unit)? = null) = handler.post {
        if (closed) { if (done != null) ui.post { done(null) }; return@post }
        var result: FlushDraftResult? = null
        storageAccess {
            var failed = false
            try {
                if (mirror.overlay != null) commitComposition(null)
                val attachedId = session?.noteId() ?: noteId
                result = session?.detach()?.also { saved ->
                    ui.post { sink.onCheckpoint(saved, saved.mutation?.finalId ?: attachedId) }
                }
            } catch (e: EditorSessionException) {
                failed = true
                Log.w(TAG, "save on close failed; retaining draft", e)
                handleFailure(e)
                drainAfterCheckpoint()
            }
            if (!failed) release()
        }
        if (done != null) ui.post { done(result) }
    }

    /** Explicit user discard: release without attempting to save the draft. */
    fun discard(done: () -> Unit) = handler.post {
        release()
        ui.post(done)
    }

    private fun release() {
        handler.removeCallbacks(saveRunnable)
        handler.removeCallbacks(caretRunnable)
        session?.destroy()
        fast?.close()
        fast = null
        session = null
        closed = true
        thread.quitSafely()
    }

    // ---- internals ----

    internal fun input(block: () -> Unit) {
        inputStartNanos = SystemClock.elapsedRealtimeNanos()
        guarded(block)
    }

    internal fun command(onUnavailable: () -> Unit = {}, block: () -> Unit) = handler.post {
        if (storageGate?.isMigrationStarted == true || closed || session == null) {
            ui.post(onUnavailable)
            return@post
        }
        inputStartNanos = SystemClock.elapsedRealtimeNanos()
        guarded(block)
        // A collapsed format toggle changes only carried formatting and
        // returns no change; the toolbar must still light up at once.
        handler.removeCallbacks(caretRunnable)
        refreshCaretState()
    }

    private fun guarded(block: () -> Unit) {
        if (closed || session == null) return
        if (storageGate?.isMigrationStarted == true) {
            ui.post { sink.onImeReset() }
            return
        }
        try {
            block()
        } catch (e: EditorSessionException) {
            handleFailure(e)
        }
    }

    internal fun handleFailure(e: EditorSessionException) {
        when (e) {
            is EditorSessionException.UnrepresentableFormat,
            is EditorSessionException.CompositionActive,
            is EditorSessionException.InvalidRange,
            is EditorSessionException.InvalidText -> {
                // A refused command changes nothing (lists.md, interpretation
                // spec); the keyboard may have assumed otherwise.
                Log.i(TAG, "refused: $e")
                ui.post { sink.onImeReset() }
                postUpdate(emptyList(), emptyList())
            }
            is EditorSessionException.StaleRevision -> {
                Log.e(TAG, "stale revision on the editor thread — mirror out of step", e)
                reloadFromEngine()
            }
            else -> {
                Log.e(TAG, "editor failure", e)
                ui.post { sink.onFailure(e); sink.onImeReset() }
                postUpdate(emptyList(), emptyList())
            }
        }
    }

    internal fun reloadFromEngine() {
        val s = session ?: return
        mirror.overlay = null
        try { s.composition()?.let { s.cancelComposition(s.revision()) } } catch (_: EditorSessionException) {}
        rev = s.revision()
        val display = s.displayText()
        mirror.reset(display)
        mirror.selStart = mirror.selStart.coerceIn(0, mirror.text.length); mirror.selEnd = mirror.selEnd.coerceIn(mirror.selStart, mirror.text.length)
        val projection = s.project(rev, EditorByteRange(0u, mirror.utf8Length.toULong()))
        postUpdate(reset = display, edits = emptyList(), windows = listOf(window(projection)))
        ui.post { sink.onImeReset() }
    }





    internal fun select(start: Int, end: Int, fromView: Boolean) {
        val s = session ?: return
        val a = minOf(start, end).coerceIn(0, mirror.text.length)
        val b = maxOf(start, end).coerceIn(0, mirror.text.length)
        val change = s.selectUtf16(rev, EditorUtf16Range(a.toULong(), b.toULong()))
        rev = change.revision
        mirror.selStart = mirror.toUtf16(change.selection.start.toInt())
        mirror.selEnd = mirror.toUtf16(change.selection.end.toInt())
        // Leaving an item whose Indent was held: the engine dropped it, so
        // redraw that line at its written depth.
        val held = heldIndentAt
        val windows = if (held != null && (mirror.selStart != held || mirror.selEnd != held)) {
            heldIndentAt = null
            listOf(window(s.project(rev, mirror.byteRange(held, held))))
        } else {
            emptyList()
        }
        if (windows.isNotEmpty() || !fromView || mirror.selStart != a || mirror.selEnd != b) postUpdate(emptyList(), windows) else publishSelection()
        scheduleCaretState()
    }

    /** Apply one accepted engine change to the mirror, then post it to the view. */
    internal fun accept(change: EditorViewChange) {
        engineNanos = SystemClock.elapsedRealtimeNanos()
        check(change.previousRevision == rev) { "change ${change.previousRevision} applied at $rev" }
        // A change with no new revision and no text is a held Indent on an
        // empty item (pending_indent.rs): remember the line to redraw later.
        val held = change.revision == change.previousRevision && change.inserted.isEmpty() &&
            change.range.start == change.range.end
        val previouslyHeld = heldIndentAt
        heldIndentAt = if (held) mirror.toUtf16(change.range.start.toInt()) else null
        val edits = ArrayList<TextEdit>(2)
        mirror.overlay?.let { o ->
            mirror.replace(o.start, o.start + o.marked.length, o.original, edits)
            mirror.overlay = null
        }
        val start = mirror.toUtf16(change.range.start.toInt())
        val end = mirror.toUtf16(change.range.end.toInt())
        if (TextFirstEditText.PROFILE) {
            Log.i(TAG, "change ${change.previousRevision}->${change.revision}: replace [$start,$end) with ${change.inserted.length} chars; projection ${change.projection.range.end - change.projection.range.start} bytes, ${change.projection.blocks.size} blocks, ${change.projection.runs.size} runs; parsed=${change.parsedSourceBytes}")
        }
        mirror.replace(start, end, change.inserted, edits)
        rev = change.revision
        lastProjection = change.projection
        mirror.selStart = mirror.toUtf16(change.selection.start.toInt())
        mirror.selEnd = mirror.toUtf16(change.selection.end.toInt())
        if (verifyMirror) verify()
        val windows = arrayListOf(window(change.projection))
        if (previouslyHeld != null && !held) {
            // Another edit dropped a held Indent; redraw that line where it now is.
            val shift = change.inserted.length - (end - start)
            val at = if (previouslyHeld >= end) previouslyHeld + shift else previouslyHeld
            if (at in 0..mirror.text.length) {
                runCatching { session?.project(rev, mirror.byteRange(at, at)) }.getOrNull()?.let { windows += window(it) }
            }
        }
        postUpdate(edits, windows)
        armSave()
        scheduleCaretState()
    }

    private fun verify() {
        val s = session ?: return
        val engine = s.displayText()
        check(engine == mirror.text.toString()) { "mirror diverged from engine display at revision $rev" }
    }

    internal fun postUpdate(edits: List<TextEdit>, windows: List<StyleWindow>, reset: String? = null) {
        seq += 1
        val update = UiUpdate(
            seq = seq,
            reset = reset,
            edits = edits,
            selStart = mirror.selStart,
            selEnd = mirror.selEnd,
            composingStart = mirror.composingStart,
            composingEnd = mirror.composingEnd,
            windows = windows,
            inputUptimeNanos = inputStartNanos,
            postedNanos = SystemClock.elapsedRealtimeNanos(),
            engineNanos = engineNanos.also { engineNanos = 0L },
        )
        publishSelection()
        ui.post { sink.onUpdate(update) }
    }

    private fun publishSelection() {
        publishedSelection = (mirror.selStart.toLong() shl 32) or (mirror.selEnd.toLong() and 0xffffffffL)
    }


    // ---- saving ----

    /**
     * The Store owns the debounce (500 ms idle, 2 s max wait, a 2 s retry after
     * a failed save); this thread only wakes when it says the next save is due,
     * then asks `saveIfDue` — which writes nothing if typing moved the idle
     * deadline on — and re-arms from the Store's new delay. One timer at a
     * time, so a keystroke costs no extra FFI call while one is armed.
     */
    internal val saveRunnable = Runnable {
        saveArmed = false
        if (closed || session == null) return@Runnable
        save(force = false)
    }

    internal fun armSave() {
        if (saveArmed || closed) return
        val delay = try { session?.saveDelay() } catch (_: EditorSessionException) { null } ?: return
        saveArmed = true
        handler.postDelayed(saveRunnable, delay.toMillis())
    }

    // ---- toolbar state ----

    private val caretRunnable = Runnable { refreshCaretState() }

    private fun scheduleCaretState() {
        handler.removeCallbacks(caretRunnable)
        handler.postDelayed(caretRunnable, CARET_STATE_DELAY_MS)
    }


    internal fun units(value: String): List<UShort> = List(value.length) { value[it].code.toUShort() }

    companion object {
        internal const val TAG = "TextFirstEngine"
        private const val CARET_STATE_DELAY_MS = 40L
    }
}

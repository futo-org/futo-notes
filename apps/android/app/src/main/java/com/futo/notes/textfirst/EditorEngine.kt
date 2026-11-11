package com.futo.notes.textfirst

import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.futo.notes.storage.GateAccess
import com.futo.notes.storage.StorageMigrationGate
import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.EditorByteRange
import uniffi.futo_notes_ffi.EditorInlineFormat
import uniffi.futo_notes_ffi.EditorInputAction
import uniffi.futo_notes_ffi.EditorParagraphKey
import uniffi.futo_notes_ffi.EditorSelectionChange
import uniffi.futo_notes_ffi.EditorSessionException
import uniffi.futo_notes_ffi.EditorUtf16Range
import uniffi.futo_notes_ffi.EditorViewChange
import uniffi.futo_notes_ffi.FlushDraftResult
import uniffi.futo_notes_ffi.NativeEditorSession
import uniffi.futo_notes_ffi.NoteStore

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
    /** A display offset the first screens must reach (where the note was last left), else its top. */
    internal val openThrough: Int = 0,
) {
    private val thread = HandlerThread("futo-editor", Process.THREAD_PRIORITY_DISPLAY).apply { start() }
    val handler = Handler(thread.looper)
    internal val ui = Handler(Looper.getMainLooper())

    // ---- editor-thread state ----
    internal var session: NativeEditorSession? = null
    internal var fast: FastSession? = null
    internal var dismissedCompletionStart: ULong? = null
    internal var rev: ULong = 0u
    internal val mirror = DisplayMirror()

    /** The keyboard's view, read by the input connection on this thread. */
    val text: CharSequence get() = mirror.text
    val selStart: Int get() = mirror.selStart
    val selEnd: Int get() = mirror.selEnd
    internal var editingCell = false
    internal val find = FindEngineState { refreshFind() }
    internal var cellRange: IntRange? = null
    internal var seq = 0
    /** The display edits each posted update carried, for view selections made behind them. */
    internal val viewEdits = ViewEditJournal()
    internal var saveArmed = false
    /** A committed external event must survive migration admission or a failed write. */
    internal var reconcilePending = false
    internal var closed = false
    private val toolbarCommands = ToolbarCommandQueue(handler) { executeCommand({}, it) }
    private var inputStartNanos = 0L
    internal var engineNanos = 0L
    /** Characters at the end of the display the view has not been given yet (progressive open). */
    internal var tailLength = 0
    internal val renderWork = RenderWork()
    internal val tailRunnable = Runnable { showNextRenderSlice() }
    /** Input, taps and commands made before the session existed (EditorEngineOpening.kt). */
    internal var awaitingOpen: ArrayDeque<() -> Unit>? = ArrayDeque()
    /** The quick first screens the view shows until the whole open lands. */
    internal var quickDisplay: String? = null

    /** Read on the UI thread when the keyboard connects. */
    @Volatile var publishedSelection = 0L
        private set
    @Volatile var publishedIme: EngineImeState? = null
        private set
    /** The display offset at the top of the view's screen, written by the view as it scrolls. */
    @Volatile var screenStart = 0


    // ---- view and toolbar (posted from the UI thread) ----

    /**
     * A selection the view made (touch, handles, arrow keys) against update
     * [viewSeq]. It is the user's newest action even when later updates are
     * still on their way to the view (a long command ran first), so it is
     * carried through their edits and echoed back, never dropped.
     */
    fun viewSelection(viewSeq: Int, start: Int, end: Int) = handler.post {
        if (closed || selectWhileOpening(viewSeq, start, end)) return@post
        selectFromView(viewSeq, start, end)
    }

    internal fun selectFromView(viewSeq: Int, start: Int, end: Int, force: Boolean = false) {
        val (a, b) = viewEdits.map(viewSeq, start, end) ?: return
        if (!force && a == mirror.selStart && b == mirror.selEnd) return
        guarded { select(a, b, fromView = true, echo = force || viewSeq != seq) }
    }

    fun toggleFormat(format: EditorInlineFormat) = toolbarCommands.post {
        if (mirror.overlay != null) commitComposition(null)
        session?.toggleFormat(rev, format)?.let(::accept)
    }

    fun blockCommand(command: EditorBlockCommand) = toolbarCommands.post {
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

    fun undo() = toolbarCommands.post {
        if (mirror.overlay != null) commitComposition(null)
        session?.undo(rev)?.let(::accept)
    }

    fun redo() = toolbarCommands.post {
        if (mirror.overlay != null) commitComposition(null)
        session?.redo(rev)?.let(::accept)
    }

    fun paste(markdown: String) = command {
        if (mirror.overlay != null) commitComposition(null)
        session?.pasteMarkdown(rev, mirror.byteRange(mirror.selStart, mirror.selEnd), markdown)?.let(::accept)
    }

    /**
     * [deliver] runs on this thread and says whether the clipboard took the text. A cut
     * removes the selection only after it did: the system clipboard refuses a large one.
     */
    fun copy(cut: Boolean, deliver: (String) -> Boolean) = command {
        if (mirror.overlay != null) commitComposition(null)
        val s = session ?: return@command
        if (mirror.selStart == mirror.selEnd) return@command
        val range = mirror.byteRange(mirror.selStart, mirror.selEnd)
        if (!deliver(s.copyMarkdown(rev, range)) || !cut) return@command
        s.cutMarkdown(rev, range).change?.let(::accept)
    }

    fun selectAll() = command { select(0, mirror.text.length, fromView = false, finishTail = false); streamTail(0) }

    /** A selection the host chooses (restoring the caret after a reload). */
    fun hostSelect(start: Int, end: Int) = command { select(start, end, fromView = false) }

    /** While the view is touched or shows its text menu, background slices wait (TextFirstEditText). */
    fun holdRender(held: Boolean) = handler.post {
        if (closed) return@post
        renderWork.held = held
        if (!held) streamTail(0)
    }

    /**
     * The view cut itself to a bounded prefix to lay out a new width
     * (TextFirstEditTextWidth.kt). Render it again from this thread's text,
     * reaching [through]; the view ignores updates made against the text it
     * dropped until this reset arrives.
     */
    fun relayoutView(through: Int) = handler.post {
        // A rotation over the quick first screens waits for the session that renders it again.
        whenOpen {
            if (closed || session == null) return@whenOpen
            if (mirror.overlay != null) resetMarkedView(emptyList()) else resetViewProgressively(through = through)
        }
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

    /** Sync already applied its authoritative mutation, including attachment identity.
     * Reconcile on the input thread, after accepted typing, without replacing the session. */
    fun reconcileExternalChanges(done: () -> Unit) = handler.post {
        if (!closed && session != null) {
            val id = session!!.noteId()
            ui.post { sink.onAttachmentId(id) }
            save(force = true, external = true)
        }
        ui.post(done)
    }

    /** The current exact source, for the screen's rename/draft paths. */
    fun sourceText(done: (String?) -> Unit) = handler.post {
        val source = try { session?.sourceText() } catch (e: EditorSessionException) { null }
        ui.post { done(source) }
    }

    /** Save before releasing. A failed detach leaves the exact session editable and retryable.
     * Ordinary vault work (a sync cycle) holding the gate is waited out, off the editor thread
     * and for a bounded time; only migration or a real save failure reports null. */
    fun close(done: ((FlushDraftResult?) -> Unit)? = null) {
        toolbarCommands.cancel()
        closeWhenAdmitted(done, SystemClock.uptimeMillis() + CLOSE_BUSY_LIMIT_MS)
    }

    private fun closeWhenAdmitted(done: ((FlushDraftResult?) -> Unit)?, deadline: Long) {
        handler.post {
            if (closed) { if (done != null) ui.post { done(null) }; return@post }
            var result: FlushDraftResult? = null
            val access = storageAccess {
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
            if (access == GateAccess.BUSY && SystemClock.uptimeMillis() < deadline) {
                if (handler.postDelayed({ closeWhenAdmitted(done, deadline) }, GATE_BUSY_RETRY_MS)) return@post
            }
            if (!closed) toolbarCommands.reopen()
            if (done != null) ui.post { done(result) }
        }
    }

    /** Explicit user discard: release without attempting to save the draft. */
    fun discard(done: () -> Unit) = handler.post {
        release()
        ui.post(done)
    }

    private fun release() {
        renderWork.reset()
        toolbarCommands.cancel()
        handler.removeCallbacks(saveRunnable)
        handler.removeCallbacks(caretRunnable)
        handler.removeCallbacks(tailRunnable)
        find.release(handler)
        session?.destroy()
        fast?.close()
        fast = null
        session = null
        mirror.release()
        awaitingOpen = null
        quickDisplay = null
        tailLength = 0
        editingCell = false
        cellRange = null
        dismissedCompletionStart = null
        publishedSelection = 0L
        publishedIme = null
        closed = true
        thread.quitSafely()
    }

    // ---- internals ----

    internal fun input(block: () -> Unit) {
        inputStartNanos = SystemClock.elapsedRealtimeNanos()
        guarded(block)
    }

    internal fun command(onUnavailable: () -> Unit = {}, block: () -> Unit) = handler.post {
        executeCommand(onUnavailable, block)
    }

    private fun executeCommand(onUnavailable: () -> Unit, block: () -> Unit) {
        if (deferredUntilOpen { executeCommand(onUnavailable, block) }) return
        if (storageGate?.isMigrationStarted == true || closed || session == null) {
            ui.post(onUnavailable)
            return
        }
        inputStartNanos = SystemClock.elapsedRealtimeNanos()
        guarded(block)
        // A collapsed format toggle changes only carried formatting and
        // returns no change; the toolbar must still light up at once.
        handler.removeCallbacks(caretRunnable)
        refreshCaretState()
    }

    private fun guarded(block: () -> Unit) {
        if (deferredUntilOpen { guarded(block) }) return
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

    /** [echo]: updates still in flight to the view would overwrite this view selection. */
    internal fun select(start: Int, end: Int, fromView: Boolean, finishTail: Boolean = true, echo: Boolean = false) {
        val s = session ?: return
        var a = minOf(start, end).coerceIn(0, mirror.text.length)
        var b = maxOf(start, end).coerceIn(0, mirror.text.length)
        val overlay = mirror.overlay
        val settle = overlay != null && (fromView || a < overlay.start || b > overlay.start + overlay.marked.length)
        if (settle) {
            // A tap leaves the keyboard's reconversion range immediately;
            // waiting for its suggestion to be accepted pins the engine caret.
            val oldEnd = checkNotNull(overlay).start + overlay.marked.length
            val oldLength = mirror.text.length
            commitComposition(null)
            val shift = mirror.text.length - oldLength
            if (a >= oldEnd) a += shift
            if (b >= oldEnd) b += shift
            ui.post { sink.onImeReset() }
        }
        if (finishTail && b > tailStart() && streaming) finishStreaming()
        val change = s.selectUtf16(rev, EditorUtf16Range(a.toULong(), b.toULong()))
        applySelectionChange(change)
        if (settle || echo || !fromView || mirror.selStart != a || mirror.selEnd != b) postUpdate(emptyList(), emptyList()) else publishSelection()
        scheduleCaretState()
    }

    internal fun applySelectionChange(change: EditorSelectionChange) {
        rev = change.revision
        mirror.selStart = mirror.toUtf16(change.selection.start.toInt())
        mirror.selEnd = mirror.toUtf16(change.selection.end.toInt())
    }

    /** Apply one accepted engine change to its authoritative mirror and bounded view projection. */
    internal fun accept(change: EditorViewChange) = acceptViewChange(change)

    internal fun verify() {
        if (!verifyMirror) return
        val s = session ?: return
        val engine = s.displayText()
        check(engine == mirror.text.toString()) { "mirror diverged from engine display at revision $rev" }
    }

    internal fun postUpdate(edits: List<TextEdit>, windows: List<StyleWindow>, reset: String? = null, sourceChanged: Boolean = false, preserveScroll: Boolean = false, paced: Boolean = false, marked: List<SpanSpec.Inline>? = null) {
        seq += 1
        viewEdits.record(seq, edits)
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
            complete = session != null && !streaming && !renderWork.stylesPending,
            sourceChanged = sourceChanged, preserveScroll = preserveScroll,
            marked = marked,
        )
        publishSelection()
        publishCell()
        if (paced) postRenderUpdate(update) else ui.post { sink.onUpdate(update) }
        scheduleCaretState()
        scheduleFindRefresh()
    }

    internal fun publishSelection() {
        publishedSelection = (mirror.selStart.toLong() shl 32) or (mirror.selEnd.toLong() and 0xffffffffL)
        val state = EngineImeState.capture(mirror.text, mirror.selStart, mirror.selEnd,
            mirror.composingStart, mirror.composingEnd,
            android.text.TextUtils.getCapsMode(mirror.text, mirror.selStart, IME_CAPS_MODES))
        publishedIme = state
        ui.post { sink.onImeState(state) }
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
        /** Re-try cadence while ordinary vault work (a sync cycle) holds the gate. */
        internal const val GATE_BUSY_RETRY_MS = 50L
        /** How long close waits for ordinary vault work before reporting failure. */
        internal const val CLOSE_BUSY_LIMIT_MS = 30_000L
        private const val CARET_STATE_DELAY_MS = 40L
    }
}

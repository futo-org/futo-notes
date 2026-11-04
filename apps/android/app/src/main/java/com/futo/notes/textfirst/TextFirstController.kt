package com.futo.notes.textfirst

import android.content.Context
import com.futo.notes.NotesStore
import android.os.SystemClock
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.io.File
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CompletableDeferred
import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.EditorInlineFormat
import uniffi.futo_notes_ffi.EditorSessionException
import uniffi.futo_notes_ffi.FlushDraftResult
import uniffi.futo_notes_ffi.NoteStore

/**
 * One open note in the text-first editor: the view, its engine, and the
 * Compose-facing state the screen and toolbar read. UI thread only.
 */
internal class TextFirstController(
    private val context: Context,
    private val core: () -> NoteStore,
    vaultRoot: File,
    private val style: TextFirstStyle,
    private val vault: NotesStore? = null,
) : EngineSink {
    private val images = ImageLoader(context, vaultRoot)
    val view = TextFirstEditText(context, style, images)
    private var engine: EditorEngine? = null
    private var opening: CompletableDeferred<Unit>? = null
    private var closing: CompletableDeferred<FlushDraftResult?>? = null

    var cellView by mutableStateOf<TableCellEditText?>(null); private set
    var opened by mutableStateOf(false); private set
    var openFailure by mutableStateOf<Throwable?>(null); private set
    /** Whether navigation can proceed without an attached editor save. */
    private var released = false
    val canNavigateWithoutSaving: Boolean get() = openFailure != null || released
    var completion by mutableStateOf<CompletionDraft?>(null); private set
    var caret by mutableStateOf(CaretState.Empty); private set
    /** Edits not yet saved as Markdown. */
    var dirty by mutableStateOf(false); private set
    var isEmpty by mutableStateOf(true); private set
    var focused by mutableStateOf(false); private set
    /** The last find result, or null before find is first used in this open note. */
    var find by mutableStateOf<FindSnapshot?>(null); private set

    var onAttachmentChanged: (String) -> Unit = {}
    var onCheckpointed: (FlushDraftResult, String) -> Unit = { _, _ -> }
    var onFailure: (EditorSessionException) -> Unit = {}

    private val latencyWindow = KeyLatencyWindow()
    private val latencyFlush = Runnable { latencyWindow.flush()?.let { Log.i("TextFirstLatency", it.toString()) } }

    init {
        vault?.nativeEditorDrafts?.put(this) {
            withContext(Dispatchers.Main.immediate) {
                suspendCancellableCoroutine { cont ->
                    val e = engine
                    if (e == null) cont.resume(true)
                    else e.checkpointForMigration { cont.resume(it) }
                }
            }
        }
        view.onTableCell = { start, end, seq -> engine?.selectDisplayRange(start, end, seq) {} }
        MainThreadWatchdog.start()
        view.setOnFocusChangeListener { _, hasFocus -> focused = hasFocus }
        view.onFrameDrawn = { timings ->
            latencyWindow.add(timings)?.let { Log.i("TextFirstLatency", it.toString()) }
            view.removeCallbacks(latencyFlush)
            view.postDelayed(latencyFlush, 1000)
        }
    }

    /** [restore] is where the note was last left; the first screens reach it and the view scrolls there. */
    fun open(noteId: String, restore: ScrollAnchor? = null, onOpened: (Throwable?) -> Unit = {}) {
        check(engine == null) { "already open" }
        opened = false
        released = false
        openFailure = null
        val ready = CompletableDeferred<Unit>()
        opening = ready
        view.restoring = restore
        val created = EditorEngine(core, noteId, this, storageGate = vault?.storageMigrationGate, openThrough = restore?.offset ?: 0)
        engine = created
        view.engine = created
        created.open { error ->
            if (engine !== created) return@open
            openFailure = error
            opened = error == null
            opening = null
            ready.complete(Unit)
            onOpened(error)
        }
    }

    // ---- EngineSink ----

    override fun onUpdate(update: UiUpdate) {
        if (update.edits.isNotEmpty() && update.reset == null && !update.append) dirty = true
        view.apply(update)
        isEmpty = view.length() <= TextFirstEditText.END_SENTINEL.length
    }

    override fun onCell(update: CellUpdate?) {
        if (update == null) { cellView = null; return }
        val e = engine ?: return
        val field = cellView ?: TableCellEditText(context, e, style).also { cellView = it; view.hideKeyboard() }
        field.apply(update)
    }
    override fun onCompletion(draft: CompletionDraft?) { completion = draft }

    override fun onFind(snapshot: FindSnapshot) {
        find = snapshot
        view.setFind(snapshot)
        snapshot.reveal?.let { (start, end) -> view.post { view.revealRange(start, end) } }
    }

    override fun onCaretState(state: CaretState) {
        caret = state
        view.setCodeInput(state.code)
    }

    override fun onAttachmentId(noteId: String) = onAttachmentChanged(noteId)

    override fun onCheckpoint(result: FlushDraftResult, noteId: String) {
        dirty = false
        onCheckpointed(result, noteId)
    }

    override fun onFailure(error: EditorSessionException) = onFailure.invoke(error)

    /** Keyboard restarts after a refused or failed edit; a benchmark counts refusals with it. */
    @Volatile var imeResets = 0; private set

    override fun onImeReset() {
        imeResets += 1
        view.restartKeyboard()
        cellView?.restartKeyboard()
    }

    // ---- commands ----

    /** Place the caret (host-chosen, e.g. a benchmark or a restored position). */
    fun select(start: Int, end: Int = start) { engine?.hostSelect(start, end) }

    fun format(format: EditorInlineFormat) { engine?.toggleFormat(format) }
    fun block(command: EditorBlockCommand) { engine?.blockCommand(command) }
    fun paste(text: String) { engine?.paste(text) }
    fun finishCellEditing() { engine?.finishCellEditing() }
    /** The shared display-selection entry point for grid taps and Find. */
    suspend fun selectDisplayRange(start: Int, end: Int = start): Boolean = viaEngine(false) { e, done -> e.selectDisplayRange(start, end) { done(it) } }
    /** One engine round trip; [default] when the editor is gone. */
    private suspend fun <T> viaEngine(default: T, call: (EditorEngine, (T) -> Unit) -> Unit): T = suspendCancellableCoroutine { cont ->
        val e = engine ?: return@suspendCancellableCoroutine cont.resume(default)
        call(e) { cont.resume(it) }
    }

    /** Open find or change its query. Highlights only: the selection, source and history are untouched. */
    suspend fun findSetQuery(query: String): FindSnapshot? = viaEngine(null) { e, done -> e.findSetQuery(query, done) }

    /** Land on the current match, then move to the next or previous one; table matches open their cell field. */
    suspend fun findStep(forward: Boolean): FindSnapshot? = viaEngine(null) { e, done -> e.findStep(forward, done) }

    suspend fun findClose(): FindSnapshot? = viaEngine(null) { e, done -> e.findClose(done) }

    fun undo() { engine?.undo() }
    fun redo() { engine?.redo() }
    fun drainCoordinatedChanges() { engine?.drainCoordinatedChanges() }

    fun dismissCompletion(draft: CompletionDraft) { engine?.dismissCompletion(draft) }
    fun refreshCompletionNoteIds() { engine?.refreshCompletionNoteIds() }

    suspend fun completionDraft(): CompletionDraft? = viaEngine(null) { e, done -> e.completionDraft(done) }

    suspend fun acceptCompletion(draft: CompletionDraft, noteId: String): Boolean = viaEngine(false) { e, done -> e.acceptCompletion(draft, noteId, done) }

    suspend fun linkDraft(): LinkDraft? = viaEngine(null) { e, done -> e.linkDraft(done) }

    suspend fun editLink(draft: LinkDraft, label: String, destination: String): Boolean = viaEngine(false) { e, done -> e.editLink(draft, label, destination, done) }

    suspend fun removeLink(draft: LinkDraft): Boolean = viaEngine(false) { e, done -> e.removeLink(draft, done) }

    suspend fun imageClaim(): ULong? = viaEngine(null) { e, done -> e.imageClaim(done) }

    // Once queued, wait for the canonical acknowledgement even if the screen
    // leaves. Otherwise the vault cleanup can delete an already-inserted image.
    suspend fun insertImage(claim: ULong, reference: String): Boolean = withContext(NonCancellable) {
        suspendCancellableCoroutine { cont ->
            val e = engine ?: return@suspendCancellableCoroutine cont.resume(false)
            e.insertImage(claim, reference) { cont.resume(it) }
        }
    }

    suspend fun checkpoint(): FlushDraftResult? = viaEngine(null) { e, done -> e.checkpoint(done) }

    suspend fun reconcileExternalChanges() = viaEngine(Unit) { e, done -> e.reconcileExternalChanges { done(Unit) } }

    suspend fun sourceText(): String? = viaEngine(null) { e, done -> e.sourceText(done) }

    /** Save and detach. A null result retains the engine and draft for retry. */
    suspend fun close(): FlushDraftResult? {
        opening?.await()
        closing?.let { return it.await() }
        val e = engine ?: return null
        val completion = CompletableDeferred<FlushDraftResult?>()
        closing = completion
        e.close { result ->
            // Finalize even if the screen's awaiting coroutine was canceled.
            if (result != null) release(e)
            closing = null
            completion.complete(result)
        }
        return completion.await()
    }

    /** Called only after the user explicitly confirms losing unsaved edits. */
    suspend fun discard() {
        opening?.await()
        val e = engine ?: return
        suspendCancellableCoroutine<Unit> { cont ->
            e.discard { release(e); cont.resume(Unit) }
        }
    }

    private fun release(e: EditorEngine) {
        if (engine !== e) return
        view.removeCallbacks(latencyFlush)
        latencyFlush.run()
        engine = null
        find = null
        view.setFind(FindSnapshot.Closed)
        cellView = null
        completion = null
        view.engine = null
        released = true
        opened = false
    }

    fun dispose() {
        vault?.nativeEditorDrafts?.remove(this)
        images.shutdown()
    }

}

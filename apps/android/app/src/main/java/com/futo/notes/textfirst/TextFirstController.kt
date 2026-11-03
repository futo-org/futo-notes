package com.futo.notes.textfirst

import android.content.Context
import android.os.SystemClock
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.io.File
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
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
    context: Context,
    private val core: () -> NoteStore,
    vaultRoot: File,
    style: TextFirstStyle,
) : EngineSink {
    private val images = ImageLoader(vaultRoot)
    val view = TextFirstEditText(context, style, images)
    private var engine: EditorEngine? = null
    private var closing: CompletableDeferred<FlushDraftResult?>? = null

    var opened by mutableStateOf(false); private set
    var openFailure by mutableStateOf<Throwable?>(null); private set
    /** Whether navigation can proceed without an attached editor save. */
    val canNavigateWithoutSaving: Boolean get() = !opened
    var caret by mutableStateOf(CaretState.Empty); private set
    /** Edits not yet saved as Markdown. */
    var dirty by mutableStateOf(false); private set
    var isEmpty by mutableStateOf(true); private set
    var focused by mutableStateOf(false); private set

    var onCheckpointed: (FlushDraftResult, String) -> Unit = { _, _ -> }
    var onFailure: (EditorSessionException) -> Unit = {}

    private val latencyWindow = KeyLatencyWindow()
    private val latencyFlush = Runnable { latencyWindow.flush()?.let { Log.i("TextFirstLatency", it.toString()) } }

    init {
        MainThreadWatchdog.start()
        view.setOnFocusChangeListener { _, hasFocus -> focused = hasFocus }
        view.onFrameDrawn = { timings ->
            latencyWindow.add(timings)?.let { Log.i("TextFirstLatency", it.toString()) }
            view.removeCallbacks(latencyFlush)
            view.postDelayed(latencyFlush, 1000)
        }
    }

    fun open(noteId: String, onOpened: (Throwable?) -> Unit = {}) {
        check(engine == null) { "already open" }
        opened = false
        openFailure = null
        val created = EditorEngine(core, noteId, this)
        engine = created
        view.engine = created
        created.open { error ->
            if (engine !== created) return@open
            openFailure = error
            opened = error == null
            onOpened(error)
        }
    }

    // ---- EngineSink ----

    override fun onUpdate(update: UiUpdate) {
        if (update.edits.isNotEmpty() && update.reset == null) dirty = true
        view.apply(update)
        isEmpty = view.length() <= TextFirstEditText.END_SENTINEL.length
    }

    override fun onCaretState(state: CaretState) { caret = state }

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
    }

    // ---- commands ----

    /** Place the caret (host-chosen, e.g. a benchmark or a restored position). */
    fun select(start: Int, end: Int = start) { engine?.hostSelect(start, end) }

    fun format(format: EditorInlineFormat) { engine?.toggleFormat(format) }
    fun block(command: EditorBlockCommand) { engine?.blockCommand(command) }
    fun undo() { engine?.undo() }
    fun redo() { engine?.redo() }
    fun drainCoordinatedChanges() { engine?.drainCoordinatedChanges() }

    suspend fun imageClaim(): ULong? = suspendCancellableCoroutine { cont ->
        val e = engine ?: return@suspendCancellableCoroutine cont.resume(null)
        e.imageClaim { cont.resume(it) }
    }

    suspend fun insertImage(claim: ULong, reference: String): Boolean = suspendCancellableCoroutine { cont ->
        val e = engine ?: return@suspendCancellableCoroutine cont.resume(false)
        e.insertImage(claim, reference) { cont.resume(it) }
    }

    suspend fun checkpoint(): FlushDraftResult? = suspendCancellableCoroutine { cont ->
        val e = engine ?: return@suspendCancellableCoroutine cont.resume(null)
        e.checkpoint { cont.resume(it) }
    }

    suspend fun sourceText(): String? = suspendCancellableCoroutine { cont ->
        val e = engine ?: return@suspendCancellableCoroutine cont.resume(null)
        e.sourceText { cont.resume(it) }
    }

    /** Save and detach. A null result retains the engine and draft for retry. */
    suspend fun close(): FlushDraftResult? {
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
        view.engine = null
        opened = false
    }

    /** Reload the note from the Store, keeping the caret and scroll where they were. */
    suspend fun reopen(noteId: String) {
        val selection = view.selectionStart
        val scroll = view.scrollY
        if (close() == null) return
        suspendCancellableCoroutine { cont -> open(noteId) { cont.resume(Unit) } }
        view.post {
            view.scrollTo(0, scroll)
            if (selection >= 0) engine?.hostSelect(selection, selection)
        }
    }

    fun dispose() = images.shutdown()

}

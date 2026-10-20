package com.futo.notes.ui

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.job
import uniffi.futo_notes_ffi.OpenNoteDisposition
import uniffi.futo_notes_ffi.OpenNoteFacts

// The recording effects every EditorSession test class drives the session
// with, and the scope they run it on — see EditorSessionTest.

internal class RecordingOpenNoteEffects(
    var noteId: String = "note",
    val dispositions: ArrayDeque<OpenNoteDisposition>,
    val log: MutableList<String>,
    val duringFacts: (() -> Unit)? = null,
    /** Suspends inside the gather, so a test can act while the session
     *  lock is held by an in-flight reconciliation. */
    val gatherGate: (suspend () -> Unit)? = null,
    val isCurrentEditor: () -> Boolean = { true },
    val gatherFailure: Exception? = null,
    val applyGate: (suspend () -> Unit)? = null,
) : OpenNoteEffects {
    override fun currentNoteId(): String = noteId

    override fun isCurrentEditor(): Boolean = isCurrentEditor.invoke()

    override suspend fun awaitCurrent(): EditorCurrent {
        log += "current"
        return EditorCurrent(DocumentSnapshot(1, "draft"), false)
    }

    override suspend fun gatherFacts(noteId: String): OpenNoteFacts {
        log += "facts:$noteId"
        duringFacts?.invoke()
        gatherGate?.invoke()
        gatherFailure?.let { throw it }
        return OpenNoteFacts(
            base = "base",
            draft = "draft",
            disk = "disk",
            renamedTo = null,
            editorFocused = true,
            editedDuringCycle = false,
        )
    }

    override fun classify(facts: OpenNoteFacts): OpenNoteDisposition {
        log += "classify"
        return dispositions.removeFirst()
    }

    override suspend fun apply(
        noteId: String,
        disposition: OpenNoteDisposition,
    ) {
        applyGate?.invoke()
        log += "apply:$noteId:${disposition::class.simpleName}"
        if (disposition is OpenNoteDisposition.FollowRename) {
            this.noteId = disposition.toId
        }
    }

    override fun resumeDraftPersistence() {
        log += "resume-draft"
    }
}

/** Records every effect the session invokes, in order. */
internal class RecordingEffects(
    val log: MutableList<String>,
    val name: String = "exit",
    val attached: () -> Boolean = { true },
    val body: suspend () -> String? = { "body" },
    val bodyCommits: Boolean = true,
    val titleCommits: Boolean = true,
    val performs: suspend () -> Boolean = { true },
    val awaitWork: suspend () -> Unit = {},
    val onPrepare: () -> Unit = {},
) : EditorExitEffects {
    var failure: EditorExitFailure? = null
    var succeeded = false
    var exitedWithoutEditor = false

    override fun isAttached(): Boolean = attached()

    override fun exitWithoutEditor() {
        exitedWithoutEditor = true
        log += "$name:exitWithoutEditor"
    }

    override fun prepare() {
        log += "$name:prepare"
        onPrepare()
    }

    override suspend fun awaitPendingWork() {
        log += "$name:awaitPendingWork:start"
        awaitWork()
        log += "$name:awaitPendingWork:end"
    }

    override suspend fun cancelPendingSave() {
        log += "$name:cancelPendingSave"
    }

    override suspend fun awaitCurrentBody(): String? {
        log += "$name:awaitCurrentBody"
        return body()
    }

    override suspend fun commitBody(body: String): Boolean {
        log += "$name:commitBody"
        return bodyCommits
    }

    override suspend fun commitTitle(): Boolean {
        log += "$name:commitTitle"
        return titleCommits
    }

    override suspend fun perform(): Boolean {
        log += "$name:perform"
        return performs()
    }

    override fun onSucceeded() {
        succeeded = true
        log += "$name:onSucceeded"
    }

    override fun onFailed(failure: EditorExitFailure) {
        this.failure = failure
        log += "$name:onFailed(${failure.name})"
    }
}

/** Held in an object, not at top level: a package-level `CoroutineScope.settle()`
 *  would capture TitleFieldStateTest's own `settle()` inside its `runBlocking`. */
internal object SessionScope {
    /** Unconfined so `end`'s launched drain runs inline up to its first real
     *  suspension — the ordering under test is then observable directly. */
    fun scope() = CoroutineScope(Dispatchers.Unconfined + Job())

    suspend fun CoroutineScope.settle() {
        coroutineContext.job.children.forEach { it.join() }
    }
}

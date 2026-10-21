package com.futo.notes.ui

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import uniffi.futo_notes_ffi.OpenNoteDisposition

internal class EditorSession(
    private val scope: CoroutineScope,
    /**
     * Starts the commit a navigation runs after it has left. It must outlive
     * [scope]: the screen's composition scope is canceled when the pop
     * animation ends, mid-write for a slow disk. The shell passes the store's
     * scope (`NotesStore.launchEditorLeave`), which a reopened note waits on.
     */
    private val launchCommit: (suspend () -> Unit) -> Job = { block -> scope.launch { block() } },
    private val onInteractionLockChanged: (Boolean) -> Unit = {},
) {
    private val mutex = Mutex()

    /** The commit a navigation started after leaving, while it runs. */
    private var exitCommit: Job? = null

    @Volatile
    private var closed = false

    private var exiting = false
    /** The open-note reconcile's mailbox wait, while it is in flight. */
    private var reconcileWait: Job? = null
    private var interruptedReconciliation: (suspend () -> Unit)? = null
    private var restartingReconciliation = false

    /** The focused note whose clean peer update waits for blur before adoption. */
    private var deferredAdoptionId: String? = null

    /**
     * True once a destructive exit has latched. One-way for this session: an
     * editor change arriving afterwards is dropped rather than buffered, and
     * every [runWork] caller returns null instead of touching the note.
     */
    val isClosing: Boolean
        get() = closed

    /** True while an exit holds the editor. The shell disables Back, the
     *  toolbar, and the text fields on it so a second exit cannot start. */
    var isInteractionLocked: Boolean = false
        private set

    /**
     * Whether an editor `change` event may be applied to the buffer. False
     * before the initial off-main read has landed (an empty echo would clobber
     * the note), once a destructive exit has latched, and while the vault is
     * being migrated to another storage root.
     */
    fun acceptsEditorChange(loaded: Boolean, storageMigrationStarted: Boolean): Boolean =
        loaded && !closed && !storageMigrationStarted

    /**
     * Run one tracked editor workflow — the debounced save, the debounced
     * rename, a live-sync adoption, an image insertion — serialized against
     * every other one AND against the exit. Returns null when a destructive
     * exit has already latched, which is the caller's signal to touch nothing.
     */
    suspend fun <T> runWork(block: suspend () -> T): T? =
        mutex.withLock { if (closed) null else block() }

    /**
     * An autosave admitted under the session lock is a miniature transaction:
     * once its engine write begins, cancellation may suppress a replacement
     * debounce but cannot discard the matching baseline/disposition update.
     * Identity-changing work uses this same lock, so the admitted save still
     * finishes against the identity it captured before rename/delete proceeds.
     */
    suspend fun <T> runAutosave(block: suspend () -> T): T? =
        mutex.withLock {
            if (closed) null else withContext(NonCancellable) { block() }
        }

    /**
     * Gather facts, ask the engine once per identity, revalidate that identity
     * once, and render its answer while serialized against every other editor
     * workflow. A same-cycle rename target gets its next pass under this lock.
     */
    suspend fun reconcileOpenNote(effects: OpenNoteEffects): OpenNoteDisposition? {
        if (!awaitEditorAheadOfAnExit(effects) { reconcileOpenNote(effects) }) return null
        return runWork {
            if (exiting) return@runWork null
            var expectedId = effects.currentNoteId()
            val seenIds = mutableSetOf(expectedId)
            var disposition: OpenNoteDisposition?
            do {
                disposition = reconcilePass(expectedId, effects)
                val nextId = effects.currentNoteId()
                if (
                    disposition !is OpenNoteDisposition.FollowRename ||
                    nextId == expectedId ||
                    !seenIds.add(nextId)
                ) {
                    break
                }
                expectedId = nextId
            } while (true)
            disposition
        }
    }

    suspend fun flushPendingEditor(effects: OpenNoteEffects) {
        effects.awaitCurrent()
        // Wait for any admitted durable save to advance its baseline.
        runAutosave { effects.persistDraft() }
    }

    /**
     * Settle the one deferred clean adoption after body-editor blur. Deferred
     * state lives here rather than in Compose so a later unrelated sync cannot
     * accidentally adopt it, and a rename/navigation drops it by identity.
     *
     * The deferral is read INSIDE the lock. The blur edge is not synchronized
     * with the cycle that produces the deferral — a reconciliation suspends on
     * its disk read while holding this lock, and the user can blur in that
     * window — so reading it first made such a settle pass see "nothing
     * deferred" and return, stranding the peer's content: there is no second
     * blur edge to retry on. Taking the lock first IS waiting for that cycle,
     * after which the fresh deferral is visible.
     */
    suspend fun settleDeferredAdoption(effects: OpenNoteEffects): OpenNoteDisposition? {
        val deferredId = runWork {
            val deferredId = deferredAdoptionId
            when {
                deferredId == null -> null
                effects.currentNoteId() != deferredId -> {
                    deferredAdoptionId = null
                    null
                }

                else -> deferredId
            }
        } ?: return null
        if (!awaitEditorAheadOfAnExit(effects) { settleDeferredAdoption(effects) }) return null
        return runWork {
            if (exiting || deferredAdoptionId != deferredId) null
            else reconcilePass(deferredId, effects)
        }
    }

    // The mailbox wait runs outside the save lock and gives way to navigation.
    private suspend fun awaitEditorAheadOfAnExit(effects: OpenNoteEffects, retry: suspend () -> Unit): Boolean {
        return awaitEditor(effects, retry)?.canProceed == true
    }

    private suspend fun awaitEditor(effects: OpenNoteEffects, retry: suspend () -> Unit): EditorCurrent? {
        if (exiting || closed) return null
        val outcome = coroutineScope {
            val wait = async { effects.awaitCurrent() }
            reconcileWait = wait
            interruptedReconciliation = retry
            try { wait.await() }
            catch (e: CancellationException) { currentCoroutineContext().ensureActive(); null }
            finally { if (reconcileWait === wait) { reconcileWait = null; interruptedReconciliation = null } }
        }
        return if (exiting || closed) null else outcome
    }

    private suspend fun reconcilePass(
        expectedId: String,
        effects: OpenNoteEffects,
    ): OpenNoteDisposition? {
        val facts =
            try {
                effects.gatherFacts(expectedId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                effects.resumeDraftPersistence()
                throw e
            }
        // THE revalidation: the disk read above suspended, so the note may have
        // changed identity or this outgoing cross-fade screen may have yielded
        // the single app-lifetime WebView to the incoming editor.
        if (effects.currentNoteId() != expectedId || !effects.isCurrentEditor()) return null

        val disposition = effects.classify(facts)
        deferredAdoptionId =
            if (disposition === OpenNoteDisposition.DeferAdopt) expectedId else null
        if (disposition === OpenNoteDisposition.Close) closed = true
        if (disposition === OpenNoteDisposition.Leave) effects.resumeDraftPersistence()
        val applied = coroutineScope {
            val wait = async { effects.apply(expectedId, disposition); true }
            reconcileWait = wait
            interruptedReconciliation = { reconcileOpenNote(effects) }
            try { wait.await() }
            catch (e: CancellationException) { currentCoroutineContext().ensureActive(); false }
            finally { if (reconcileWait === wait) { reconcileWait = null; interruptedReconciliation = null } }
        }
        if (!applied) {
            effects.resumeDraftPersistence()
            return null
        }
        return disposition
    }

    /**
     * THE exit verb: admission, latches, drain, commit, effect.
     *
     * Deliberately NOT a suspend function. The latches have to be set between
     * the user's tap and the first suspension — Compose's `rememberCoroutineScope`
     * dispatches on the next frame, so a `suspend fun` called from `launch`
     * would leave the whole frame open for a keystroke, a second Back, or a
     * queued save to slip past.
     */
    fun end(exit: EditorExit, effects: EditorExitEffects) {
        val plan = requireNotNull(EXIT_PLANS[exit]) { "no exit plan for $exit" }

        if (!effects.isAttached()) {
            effects.exitWithoutEditor()
            return
        }
        // A destructive exit (delete, or a peer's delete) owns the leave. A
        // navigation that left alongside it would pop a second screen.
        if (plan.leavesFirst && closed) return
        if (plan.locksInteraction) {
            if (exiting) return
            exiting = true
            setInteractionLocked(true)
        }
        if (plan.closes) {
            if (closed) return
            closed = true
        }
        // This exit takes over the mailbox wait; cancel the competing reconciliation.
        val wait = reconcileWait
        val interrupted = if (wait != null) interruptedReconciliation else null
        wait?.cancel()
        effects.prepare()

        if (plan.leavesFirst) {
            leaveThenCommit(effects, interrupted)
            return
        }

        scope.launch {
            // `succeeded` gates the unlatch in `finally` below: a completed
            // NAVIGATE/MOVE/DELETE leaves its latches set on purpose (the
            // screen is going away), so only an exit that did NOT leave
            // resets them. The `finally` — not just the old refusal branch —
            // is what makes that reset run when an effect THROWS instead of
            // returning false: `perform()`/`awaitCurrentBody()`/`commitBody()` are
            // arbitrary suspend calls into the shell, and an uncaught
            // exception from any of them used to skip straight past the
            // unlatch code, leaving `isInteractionLocked` true forever — Back,
            // the toolbar, and every text field stayed dead until process
            // death (F3).
            var succeeded = false
            try {
                effects.awaitPendingWork()
                var failure: EditorExitFailure? = null
                val outcome = drain(destructive = plan.closes) {
                    if (!effects.isAttached()) return@drain false
                    effects.cancelPendingSave()
                    val body = effects.awaitCurrentBody()
                    if (body == null) {
                        failure = EditorExitFailure.UNFLUSHED
                        return@drain false
                    }
                    if (!effects.commitBody(body)) {
                        failure = EditorExitFailure.BODY
                        return@drain false
                    }
                    if (plan.commitsTitle && !effects.commitTitle()) {
                        failure = EditorExitFailure.TITLE
                        return@drain false
                    }
                    if (!effects.isAttached()) return@drain false
                    if (!plan.performsInsideDrain) return@drain true
                    effects.perform().also { if (!it) failure = EditorExitFailure.ACTION }
                }
                if (outcome == null) failure = EditorExitFailure.REJECTED

                val left = when {
                    outcome != true -> false
                    plan.performsInsideDrain -> true
                    else -> effects.perform().also {
                        if (!it) failure = EditorExitFailure.ACTION
                    }
                }

                if (left) {
                    succeeded = true
                    effects.onSucceeded()
                    return@launch
                }
                failure?.let(effects::onFailed)
            } finally {
                // A refused exit — including one an effect ended by throwing —
                // must leave the editor usable and retryable: unlatch
                // everything this call latched.
                if (!succeeded) {
                    if (plan.locksInteraction) {
                        exiting = false
                        setInteractionLocked(false)
                    }
                    if (plan.closes) closed = false
                    rerunInterrupted(interrupted)
                }
            }
        }
    }

    /**
     * The editor stays open: finish the reconcile this exit interrupted — once.
     * Back pressed again and again against a busy page refuses again and again,
     * and each refusal must not stack up another reconcile behind the last.
     */
    private fun rerunInterrupted(interrupted: (suspend () -> Unit)?) {
        if (interrupted == null || restartingReconciliation) return
        restartingReconciliation = true
        scope.launch {
            try {
                interrupted()
            } finally {
                restartingReconciliation = false
            }
        }
    }

    /**
     * Navigation's half of [end]: leave, then drain and commit.
     *
     * A picker round trip still in flight is awaited BEFORE leaving — its
     * insert needs this screen's editor attachment, which leaving gives up.
     * Then the effect runs, and the drain + commit starts on [launchCommit] in
     * the same continuation: nothing can dispose the screen between the two,
     * so [whenExitSettles] always sees the commit.
     *
     * Nothing after the effect can refuse the exit. A body or title that does
     * not commit is reported ([EditorExitEffects.onFailed]) and left to the
     * screen's leave work, which runs once the commit settles: the draft
     * register keeps the unsaved body (F8) and the mailbox delivers an edit the
     * editor had not reported yet. A commit that throws is reported the same
     * way instead of crashing a scope the screen does not own.
     *
     * An attachment lost before the effect (another editor took the WebView)
     * still commits — the body was captured while it was ours — but does not
     * navigate, and unlatches so this editor stays usable.
     */
    private fun leaveThenCommit(effects: EditorExitEffects, interrupted: (suspend () -> Unit)?) {
        scope.launch {
            var left = false
            try {
                effects.awaitPendingWork()
                if (effects.isAttached()) {
                    left = effects.perform()
                    if (!left) effects.onFailed(EditorExitFailure.ACTION)
                }
                exitCommit = launchCommit { drainAndCommit(effects) }
                if (left) effects.onSucceeded()
            } finally {
                if (!left) {
                    exiting = false
                    setInteractionLocked(false)
                    rerunInterrupted(interrupted)
                }
            }
        }
    }

    /** Navigation's drain: mailbox → body → title, reported, never refusing. */
    private suspend fun drainAndCommit(effects: EditorExitEffects) {
        var failure: EditorExitFailure? = null
        try {
            val outcome = runWork {
                effects.cancelPendingSave()
                val body = effects.awaitCurrentBody()
                if (body == null) {
                    failure = EditorExitFailure.UNFLUSHED
                    return@runWork
                }
                if (!effects.commitBody(body)) {
                    failure = EditorExitFailure.BODY
                    return@runWork
                }
                if (!effects.commitTitle()) failure = EditorExitFailure.TITLE
            }
            if (outcome == null) failure = EditorExitFailure.REJECTED
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            effects.onCommitError(e)
            failure = EditorExitFailure.THREW
        }
        failure?.let(effects::onFailed)
    }

    /**
     * Run [block] once the commit a navigation started after leaving has
     * settled — at once when there is none. The screen's leave work goes
     * through here: run while the commit is still in flight, it would write
     * the body a second time against the same base (a spurious conflict copy),
     * delete a quick-capture note whose first keystrokes were still in the
     * editor, or release the draft register entry before the body is durable.
     */
    fun whenExitSettles(block: () -> Unit) {
        val commit = exitCommit
        if (commit == null || commit.isCompleted) {
            block()
        } else {
            launchCommit {
                commit.join()
                block()
            }
        }
    }

    /** A destructive drain runs even though [closed] is already latched — it is
     *  what latched it. Every other drain is an ordinary tracked workflow. */
    private suspend fun <T> drain(destructive: Boolean, block: suspend () -> T): T? =
        if (destructive) mutex.withLock { block() } else runWork(block)

    private fun setInteractionLocked(locked: Boolean) {
        isInteractionLocked = locked
        onInteractionLockChanged(locked)
    }
}

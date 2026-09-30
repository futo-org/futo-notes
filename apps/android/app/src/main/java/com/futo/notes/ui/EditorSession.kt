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
import uniffi.futo_notes_ffi.OpenNoteFacts

/**
 * The shell boundary for one open-note reconciliation pass. The session owns
 * serialization, deferred-adoption lifetime, and identity/attachment
 * revalidation; the screen owns gathering its live editor/disk facts and
 * rendering the Rust engine's disposition.
 */
internal interface OpenNoteEffects {
    fun currentNoteId(): String

    /** This screen still owns the app-lifetime editor WebView. */
    fun isCurrentEditor(): Boolean

    /**
     * Read the live editor into the screen's draft WITHOUT ending the editing
     * session, and say what the read came back with. The draft `change`
     * messages delivered lags the editor (a streaming note withholds them; an
     * edit spends 200 ms in the debounce), and [gatherFacts] reads that draft.
     */
    suspend fun captureEditor(): EditorCaptureOutcome

    suspend fun gatherFacts(noteId: String): OpenNoteFacts

    fun classify(facts: OpenNoteFacts): OpenNoteDisposition

    /** Re-arm a dirty draft after fact gathering cancelled its debounce. */
    fun resumeDraftPersistence()

    fun apply(noteId: String, disposition: OpenNoteDisposition)
}

/**
 * One note is open; here is every way it ends.
 *
 * An open editor runs four asynchronous workflows against ONE note identity —
 * the debounced body save, the debounced title rename, the live-sync adoption,
 * and an image insertion — while the user can leave at any moment through Back,
 * the system back gesture, a resolved wikilink, Move, or Delete. Every one of
 * those exits has to stop that work, drain what is already in flight, and commit
 * the freshest body BEFORE its own effect runs, or an async completion lands
 * against a note identity that no longer exists: a save that captured the
 * pre-rename id recreates a ghost note, a rename that lands after a delete
 * resurrects the file.
 *
 * Those rules used to live in four mutually-unaware gates and a 55-line closure
 * inside `NoteEditorScreen`. They live here now, as ONE drain-and-commit verb
 * ([end]) with the per-exit differences declared as data ([ExitPlan]). The
 * effects are injected ([EditorExitEffects]), so the ORDER this class calls them
 * in is exactly what `EditorSessionTest` asserts.
 *
 * ADR-0001: the session owns *when* work runs and in what order. What a save
 * means — identity, collisions, persist-or-park — stays in the engine.
 *
 * ## The drain table
 *
 * | exit | latches (synchronous) | drain | commit | own effect |
 * | --- | --- | --- | --- | --- |
 * | [EditorExit.NAVIGATE] | interaction lock (one exit at a time) | serialize | capture → body → title | after the drain |
 * | [EditorExit.MOVE] | — | serialize | capture → body | inside the drain |
 * | [EditorExit.DELETE] | closed (one-way) | serialize, destructive | capture → body | inside the drain |
 *
 * "Serialize" is the whole drain on Android: every tracked workflow runs inside
 * [runWork], so taking the same lock IS waiting for the in-flight one. A
 * destructive drain additionally latches [isClosing] first, which makes every
 * workflow queued behind it return `null` instead of touching the note.
 *
 * The lock only orders work that has already reached [runWork]. A picker round
 * trip (image insert) can return and queue its own [runWork] call on a later
 * dispatch than an exit's, so [EditorExitEffects.awaitPendingWork] runs before
 * every drain to close that gap — an exit that reached the lock first used to
 * drain a stale, empty body and delete the note out from under the insert.
 */
internal enum class EditorExit {
    /** Back, the system back gesture, or a resolved wikilink. */
    NAVIGATE,

    /** The destination picker committed a folder. */
    MOVE,

    /** Confirmed delete. */
    DELETE,
}

/** Where an exit stopped short of leaving, so the shell can word the message. */
internal enum class EditorExitFailure {
    /** The editor could not hand back its current body. */
    CAPTURE,

    /** The body could not be persisted or parked. */
    BODY,

    /** A pending rename could not commit. */
    TITLE,

    /** The exit's own effect (move / delete) failed. */
    ACTION,

    /** A destructive exit latched first, so this one never ran. */
    REJECTED,
}

/**
 * Everything an exit needs from the shell. Split this way so the session owns
 * the ORDER and the shell owns the note state: `captureBody` is a WebView
 * round-trip for [EditorExit.NAVIGATE] but the live buffer for the other two,
 * and `commitBody` is persist-or-park for navigation but a plain write for move
 * and delete — both differences are the shell's, not the ordering's.
 */
internal interface EditorExitEffects {
    /** Whether the editor attachment this exit was admitted under is current. */
    fun isAttached(): Boolean = true

    /**
     * Leave with NO editor attached. There is nothing to drain and no buffer to
     * commit, so the session hands the exit straight here instead of committing
     * against an unknown body. Only the legacy-WebView notice (github#8) acts on
     * it — it renders no editor at all and its Back must still work; every other
     * detached state means the editor is mid-attach, and the exit is dropped.
     */
    fun exitWithoutEditor() {}

    /**
     * Synchronous work that must happen between the user's tap and the first
     * suspension — cancelling the debounced save, dropping focus, blurring the
     * editor. Runs after the latches, so a change arriving from here on is
     * already fenced.
     */
    fun prepare() {}

    /**
     * Suspend until an async producer that has not yet reached [EditorSession.runWork]
     * settles, so the drain below captures its result instead of racing it.
     * [runWork] only serializes work that is ALREADY inside the lock; a picker
     * round trip (image insert) can return and queue its own [EditorSession.runWork]
     * call on a later dispatch than this exit's, so the lock alone does not
     * order them — an exit that reached the lock first would drain the stale
     * body and, seeing it empty and the note untouched, delete it out from
     * under the insert still in flight. Called once, right after [prepare],
     * before the drain.
     *
     * [EditorExit.NAVIGATE] and [EditorExit.MOVE] both override this: neither
     * exit disposes the editor as part of its OWN [perform] the way navigation
     * used to be assumed to, but navigation's `perform` does leave (see
     * `navigateAfterSaving`), so a body it drains stale is gone for good. Move
     * keeps the same attachment open afterward, so racing it costs only a
     * window where the on-disk copy briefly lags the live one — waiting here
     * removes that window instead of leaving it to the ordinary autosave to
     * close.
     *
     * [EditorExit.DELETE] deliberately does NOT override this. It already
     * latches [isClosing] before its own drain runs, which makes ANY
     * [EditorSession.runWork] queued behind it — including a pending image
     * insert — return null without running: the insert's own file write never
     * happens, so nothing is orphaned, and delete is not held up finishing
     * work whose only destination is a note the user just chose to discard.
     */
    suspend fun awaitPendingWork() {}

    /**
     * Stop the debounced body save. Called as the FIRST step inside the drain,
     * so a save already running has finished and only a queued debounce is
     * dropped — cancelling it earlier would tear down a write mid-flight.
     */
    suspend fun cancelPendingSave() {}

    /** The freshest body, or null when the editor could not answer. */
    suspend fun captureBody(): String?

    /** Persist or park exactly [body]. False = still pending, do not leave. */
    suspend fun commitBody(body: String): Boolean

    /** Commit a pending title rename. False = still pending, do not leave. */
    suspend fun commitTitle(): Boolean = true

    /** The exit's own effect: navigate away, move the file, delete the note. */
    suspend fun perform(): Boolean

    fun onSucceeded() {}

    fun onFailed(failure: EditorExitFailure) {}
}

/**
 * How one exit differs from the others. Everything else about [EditorSession.end]
 * is common, which is the point of the type.
 */
private data class ExitPlan(
    /** Latch the session closed before the first suspension (destructive). */
    val closes: Boolean,
    /** Refuse UI input for the duration, and refuse a second exit. */
    val locksInteraction: Boolean,
    /** Commit a pending rename after the body (see the platform note below). */
    val commitsTitle: Boolean,
    /** Run the exit's own effect while still holding the drain lock. */
    val performsInsideDrain: Boolean,
)

private val EXIT_PLANS = mapOf(
    // Navigation is the only exit that can be started by three affordances at
    // once (Back, the back gesture, a wikilink tap), so it is the only one that
    // locks interaction. It commits the title AFTER the body: the body is
    // flushed to the id the editor believes it is on, then the rename moves the
    // file. (iOS orders these the other way; see the MR that introduced this
    // class.)
    EditorExit.NAVIGATE to ExitPlan(
        closes = false,
        locksInteraction = true,
        commitsTitle = true,
        performsInsideDrain = false,
    ),
    EditorExit.MOVE to ExitPlan(
        closes = false,
        locksInteraction = false,
        commitsTitle = false,
        performsInsideDrain = true,
    ),
    // Delete latches CLOSED synchronously, which is what closes the window
    // between the confirm tap and this coroutine acquiring the lock: every
    // workflow queued in that window returns null instead of writing, so
    // nothing can resurrect the file after it goes.
    EditorExit.DELETE to ExitPlan(
        closes = true,
        locksInteraction = false,
        commitsTitle = false,
        performsInsideDrain = true,
    ),
)

/** Reads a background flush makes of a page that is busy finishing a load; see
 *  [EditorSession.refreshFromLiveEditor]. iOS's exit retries twice (3 in all). */
internal const val LIFECYCLE_READ_ATTEMPTS = 3

internal class EditorSession(
    private val scope: CoroutineScope,
    private val onInteractionLockChanged: (Boolean) -> Unit = {},
) {
    private val mutex = Mutex()

    @Volatile
    private var closed = false

    private var exiting = false
    /** The open-note reconcile's editor read, while it is in flight. */
    private var reconcileRead: Job? = null
    private var reconcileRetry: (suspend () -> Unit)? = null
    private var reconcileRetryInFlight = false

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
        if (!readEditorAheadOfAnExit(effects) { reconcileOpenNote(effects) }) return null
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

    /**
     * The app is leaving the foreground: read the LIVE editor into the screen's
     * draft so the flush that follows saves what the user typed, not what the
     * editor last reported (RC-92).
     *
     * A note that is still streaming its tail reports no `change` at all — it
     * never reports a prefix (O6) — and a typed edit spends 200 ms in the
     * bundle's debounce, so the register the lifecycle flush pulls lags the
     * editor by exactly the text most likely to be lost. This is the exit's
     * bounded, single-outstanding read ([readEditorAheadOfAnExit]): an answer
     * of no live document, another note's document, or a busy renderer leaves
     * the draft as it is, and the flush that follows saves only what the
     * editor already reported — never `''`, never a prefix. An exit that
     * starts meanwhile cancels the read; its own read is the one that counts.
     *
     * Ends by taking the session lock once: an autosave already writing has
     * then advanced the baseline, so the flush that follows does not write a
     * stale base over its own note and mint a conflict copy.
     */
    suspend fun refreshFromLiveEditor(effects: OpenNoteEffects) {
        var outcome = readEditor(effects) {}
        // A big note edited while it streams settles its tail INSIDE the first
        // read, which can outlast the capture deadline. That read is still
        // outstanding in the page and answers in time, so ask again: the retry
        // joins it (one read at a time) instead of queueing another. An exit
        // retries the same way. Anything still unanswered after the last
        // attempt keeps the stored bytes; the read's own `change` reaches the
        // ordinary save if the process lives to hear it.
        var attempts = 1
        while (outcome == EditorCaptureOutcome.TimedOut && attempts < LIFECYCLE_READ_ATTEMPTS) {
            attempts += 1
            outcome = readEditor(effects) {}
        }
        when (outcome) {
            is EditorCaptureOutcome.Captured, EditorCaptureOutcome.NoLiveDocument -> runWork {}
            EditorCaptureOutcome.NotOurs, EditorCaptureOutcome.TimedOut, null -> Unit
        }
    }

    /**
     * Settle the one deferred clean adoption after body-editor blur. Deferred
     * state lives here rather than in Compose so a later unrelated sync cannot
     * accidentally adopt it, and a rename/navigation drops it by identity.
     *
     * The deferral is read INSIDE the lock. The blur edge is not synchronised
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
        if (!readEditorAheadOfAnExit(effects) { settleDeferredAdoption(effects) }) return null
        return runWork {
            if (exiting || deferredAdoptionId != deferredId) null
            else reconcilePass(deferredId, effects)
        }
    }

    /**
     * Read the editor BEFORE the facts (RC-08), OUTSIDE the session lock, and
     * give way to an exit.
     *
     * The draft is kept current by `change` messages, and the editor withholds
     * those while a large note streams and for the change debounce: classified
     * on that draft, an edit only the editor knew about read as "nothing to
     * lose", and a peer edit was adopted over it or a peer delete closed the
     * note. The outcomes mean what they mean to an exit ([editorExitBody]): no
     * live document leaves the draft as the freshest body; a busy renderer or
     * another note's document cannot answer for this one, so no verdict is
     * taken — and the read is not retried.
     *
     * The read runs under the capture deadline, against a page that may be
     * busy or wedged, so it must not hold the lock every exit drains: Back
     * waited it out before starting its own read (FB-5 refute: 15.2 s against
     * 9.3 s). An exit that starts meanwhile cancels it ([end]); its own read
     * is the one that counts. `false` means: take no verdict. An exit that
     * then stops short of leaving runs [retry], so the peer's change it
     * interrupted is not left unapplied until the next sync.
     */
    private suspend fun readEditorAheadOfAnExit(
        effects: OpenNoteEffects,
        retry: suspend () -> Unit,
    ): Boolean =
        when (readEditor(effects, retry)) {
            is EditorCaptureOutcome.Captured, EditorCaptureOutcome.NoLiveDocument -> true
            EditorCaptureOutcome.NotOurs, EditorCaptureOutcome.TimedOut, null -> false
        }

    /** The read itself: what the editor answered, or `null` when an exit took
     *  over (or the session is already leaving). */
    private suspend fun readEditor(
        effects: OpenNoteEffects,
        retry: suspend () -> Unit,
    ): EditorCaptureOutcome? {
        if (exiting || closed) return null
        val outcome = coroutineScope {
            val read = async { effects.captureEditor() }
            reconcileRead = read
            reconcileRetry = retry
            try {
                read.await()
            } catch (e: CancellationException) {
                // Our own cancellation propagates; an exit's cancel of the
                // read alone is an answer: no verdict.
                currentCoroutineContext().ensureActive()
                null
            } finally {
                if (reconcileRead === read) {
                    reconcileRead = null
                    reconcileRetry = null
                }
            }
        }
        if (exiting || closed) return null
        return outcome
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
        effects.apply(expectedId, disposition)
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
        if (plan.locksInteraction) {
            if (exiting) return
            exiting = true
            setInteractionLocked(true)
        }
        if (plan.closes) {
            if (closed) return
            closed = true
        }
        // This exit reads the editor itself; a reconcile's read must not make
        // it wait (see readEditorAheadOfAnExit).
        val read = reconcileRead
        val interrupted = if (read != null) reconcileRetry else null
        read?.cancel()
        effects.prepare()

        scope.launch {
            // `succeeded` gates the unlatch in `finally` below: a completed
            // NAVIGATE/MOVE/DELETE leaves its latches set on purpose (the
            // screen is going away), so only an exit that did NOT leave
            // resets them. The `finally` — not just the old refusal branch —
            // is what makes that reset run when an effect THROWS instead of
            // returning false: `perform()`/`captureBody()`/`commitBody()` are
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
                    val body = effects.captureBody()
                    if (body == null) {
                        failure = EditorExitFailure.CAPTURE
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
                    // The editor stays open: finish the reconcile this exit
                    // interrupted — once. Back pressed again and again against
                    // a busy page refuses again and again, and each refusal
                    // must not stack up another reconcile behind the last.
                    if (interrupted != null && !reconcileRetryInFlight) {
                        reconcileRetryInFlight = true
                        scope.launch {
                            try {
                                interrupted()
                            } finally {
                                reconcileRetryInFlight = false
                            }
                        }
                    }
                }
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

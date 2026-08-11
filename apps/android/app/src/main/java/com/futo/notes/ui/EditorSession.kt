package com.futo.notes.ui

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
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

internal class EditorSession(
    private val scope: CoroutineScope,
    private val onInteractionLockChanged: (Boolean) -> Unit = {},
) {
    private val mutex = Mutex()

    @Volatile
    private var closed = false

    private var exiting = false

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
    suspend fun reconcileOpenNote(effects: OpenNoteEffects): OpenNoteDisposition? =
        runWork {
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
    suspend fun settleDeferredAdoption(effects: OpenNoteEffects): OpenNoteDisposition? =
        runWork {
            val deferredId = deferredAdoptionId
            when {
                deferredId == null -> null
                effects.currentNoteId() != deferredId -> {
                    deferredAdoptionId = null
                    null
                }

                else -> reconcilePass(deferredId, effects)
            }
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
        effects.prepare()

        scope.launch {
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
                effects.onSucceeded()
                return@launch
            }
            // A refused exit must leave the editor usable and retryable: unlatch
            // everything this call latched, then report why.
            if (plan.locksInteraction) {
                exiting = false
                setInteractionLocked(false)
            }
            if (plan.closes) closed = false
            failure?.let(effects::onFailed)
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

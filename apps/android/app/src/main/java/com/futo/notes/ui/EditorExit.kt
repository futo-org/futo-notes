package com.futo.notes.ui

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
 * | [EditorExit.NAVIGATE] | interaction lock (one exit at a time) | serialize, after leaving | mailbox → body → title | BEFORE the drain |
 * | [EditorExit.MOVE] | — | serialize | mailbox → body | inside the drain |
 * | [EditorExit.DELETE] | closed (one-way) | serialize, destructive | mailbox → body | inside the drain |
 *
 * Navigation leaves first and commits after, the way the iOS back swipe always
 * has: the pop animation used to wait for a WebView round trip and a disk
 * write. The commit runs on a scope that outlives the screen
 * ([EditorSession]'s `launchCommit`), and the screen's own leave work —
 * the fallback flush, the untouched-capture delete, releasing the draft
 * register entry — waits for it ([whenExitSettles]). Until then the note's
 * draft provider stays registered, so a backgrounding flush still covers it.
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
    UNFLUSHED,

    /** A commit after navigation already left threw instead of answering. */
    THREW,

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
 * How one exit differs from the others. Everything else about [EditorSession.end]
 * is common, which is the point of the type.
 */
internal data class ExitPlan(
    /** Latch the session closed before the first suspension (destructive). */
    val closes: Boolean,
    /** Refuse UI input for the duration, and refuse a second exit. */
    val locksInteraction: Boolean,
    /** Commit a pending rename after the body (see the platform note below). */
    val commitsTitle: Boolean,
    /** Run the exit's own effect while still holding the drain lock. */
    val performsInsideDrain: Boolean,
    /**
     * Run the exit's own effect BEFORE the drain, then drain and commit on the
     * session's commit scope. Only navigation: its effect removes the screen,
     * which a drain neither needs nor can be refused by once the user has left.
     */
    val leavesFirst: Boolean = false,
)

internal val EXIT_PLANS = mapOf(
    // Navigation is the only exit that can be started by three affordances at
    // once (Back, the back gesture, a wikilink tap), so it is the only one that
    // locks interaction. It commits the title AFTER the body: the body is
    // flushed to the id the editor believes it is on, then the rename moves the
    // file. (iOS orders these the other way; see the MR that introduced this
    // class.) It leaves before either commit runs.
    EditorExit.NAVIGATE to ExitPlan(
        closes = false,
        locksInteraction = true,
        commitsTitle = true,
        performsInsideDrain = false,
        leavesFirst = true,
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

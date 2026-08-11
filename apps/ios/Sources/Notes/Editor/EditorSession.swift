import Foundation

/// The asynchronous workflows one open note runs against ONE identity.
///
/// Each is a cancellation-aware chain (see `EditorSession.schedule`): awaiting
/// the newest handle waits for every older one too, which is what lets an exit
/// drain a whole workflow by awaiting a single task.
enum EditorWork: CaseIterable {
    /// The debounced body save.
    case save
    /// The debounced inline-title rename (and the ⋯ Rename alert).
    case rename
    /// Live-sync adoption of an on-disk change to the open note.
    case adopt
    /// Presenting and committing a folder move.
    case move
}

/// Every way an open note ends.
enum EditorExit {
    /// Back, the leading-edge swipe, or a resolved wikilink push.
    case navigate
    /// Present the destination picker (drain only — nothing is committed until
    /// the user chooses).
    case prepareMove
    /// The picker chose a destination.
    case move
    /// Confirmed delete.
    case delete
}

/// Where an exit stopped short of leaving, so the shell can word the message.
enum EditorExitFailure {
    /// The editor could not hand back its current body.
    case capture
    /// The body could not be persisted or parked.
    case body
    /// A pending rename could not commit.
    case title
    /// The exit's own effect (move / delete) failed.
    case action
}

/// Everything an exit needs from the shell. Injected as closures so the ORDER
/// `EditorSession.end` calls them in is what `EditorSessionTests` asserts.
///
/// ADR-0001: what a save MEANS — identity, collisions, persist-or-park — stays
/// in the engine and is reached through these closures. The session owns only
/// when they run and in what order.
struct EditorExitEffects {
    /// Synchronous work between the user's tap and the first suspension —
    /// blurring the editor, dismissing a sheet. Runs after the latches.
    var prepare: @MainActor () -> Void = {}
    /// The freshest body, or nil when the editor could not answer.
    var captureBody: @MainActor () async -> String? = { nil }
    /// Persist or park exactly this snapshot. False = still pending; do not leave.
    var commitBody: @MainActor (String) async -> Bool = { _ in true }
    /// Commit a pending title rename that the drain reported as uncommitted.
    var commitTitle: @MainActor () async -> Bool = { true }
    /// The exit's own effect, given the body that was committed (nil when the
    /// exit commits no body).
    var perform: @MainActor (String?) async -> Bool = { _ in true }
    var onSucceeded: @MainActor () -> Void = {}
    /// `lateContent` is an editor change that arrived while the exit ran and was
    /// quarantined but never committed; `attemptedBody` is the snapshot the exit
    /// was trying to persist. Both nil when there was none.
    var onFailed: @MainActor (EditorExitFailure, String?, String?) -> Void = { _, _, _ in }
}

/// What an editor change event may do while the session is in a given state.
enum EditorChangeDisposition: Equatable {
    /// Before the initial off-main read lands. Applying it would let an empty
    /// setContent echo be saved back over the real note.
    case ignore
    /// A destructive exit has latched. Hold the change aside so a failed delete
    /// can restore it and a committed one can discard it.
    case quarantine
    case apply
}

/// How one exit differs from the others. Everything else about
/// `EditorSession.end` is shared, which is the point of the type.
private struct EditorExitPlan {
    /// Refuse a second exit while this one runs (and lock the UI for it).
    var admitsOne = false
    /// Cancelled synchronously, before the first suspension.
    var cancelsBeforeDrain: [EditorWork] = []
    /// Awaited, in this order, before anything is committed.
    var drains: [EditorWork] = []
    /// The exit registers its own task under this workflow, so a later exit
    /// draining that workflow waits for this one too.
    var registersAs: EditorWork? = nil
    /// Cancel + await the debounced save, capture the body, commit it.
    var commitsBody = false
    /// Use the rename drain's result, retrying once when it did not commit.
    var commitsTitle = false
    /// Latch the session closed before the first suspension.
    var closes = false
    /// Refuse UI interaction for the duration.
    var locksInteraction = false
    /// Fold late (quarantined) editor changes into the commit until none is left.
    var drainsQuarantine = false

    static func of(_ exit: EditorExit) -> EditorExitPlan {
        switch exit {
        case .navigate:
            return EditorExitPlan(
                admitsOne: true,
                drains: [.adopt, .move, .rename],
                commitsBody: true,
                commitsTitle: true,
                locksInteraction: true
            )
        case .prepareMove:
            return EditorExitPlan(
                cancelsBeforeDrain: [.move],
                drains: [.adopt, .move, .rename],
                registersAs: .move
            )
        case .move:
            return EditorExitPlan(
                cancelsBeforeDrain: [.move],
                drains: [.adopt, .move, .rename],
                registersAs: .move,
                commitsBody: true,
                locksInteraction: true
            )
        case .delete:
            return EditorExitPlan(
                cancelsBeforeDrain: EditorWork.allCases,
                drains: [.adopt, .move, .rename, .save],
                commitsBody: true,
                closes: true,
                drainsQuarantine: true
            )
        }
    }
}

/// One note is open; here is every way it ends.
///
/// An open editor runs four asynchronous workflows against ONE note identity
/// (`EditorWork`) while the user can leave at any moment — Back, the leading-edge
/// swipe, a resolved wikilink, Move, Delete. Every exit has to stop that work,
/// drain what is already in flight, and commit the freshest body BEFORE its own
/// effect runs, or an async completion lands against an identity that no longer
/// exists: a save that captured the pre-rename id recreates a ghost note, a
/// rename that lands after a delete resurrects the file.
///
/// Those rules used to be four hand-ordered sequences over five bare `Task`
/// handles and three latches inside `NoteEditorView`. They are cases of ONE verb
/// here — `end(_:effects:)` runs admission → latch → cancel → drain → commit →
/// effect — with the per-exit differences declared as data (`EditorExitPlan`).
///
/// ## The drain table
///
/// | exit | admission | cancels | drains | commits | latches |
/// | --- | --- | --- | --- | --- | --- |
/// | `.navigate` | one at a time | — | adopt, move, rename | title, then body | interaction |
/// | `.prepareMove` | supersedes | move | adopt, move, rename | — | — |
/// | `.move` | supersedes | move | adopt, move, rename | body | interaction |
/// | `.delete` | one-way | all four | all four | body (+ late changes) | closed |
///
/// The body commit is always the same three steps: cancel the debounced save,
/// await it, capture the live body, then hand that exact snapshot to the engine.
///
/// Cancelling BEFORE draining is what makes delete safe: the cancels and the
/// closed latch both land synchronously, in the window between the confirm tap
/// and this session's task actually running, so nothing new is admitted and the
/// drain only has to wait for what was already in flight.
@MainActor
final class EditorSession {
    private var work: [EditorWork: Task<Bool, Never>] = [:]

    /// Set by the destructive exit, before its first suspension. One-way for a
    /// committed delete; released when the delete fails so the editor stays
    /// usable. Gates every scheduled workflow and every editor change.
    private(set) var isClosing = false

    /// An editor change that arrived after the session latched closed. A
    /// committed delete discards it; a failed one hands it back so no late
    /// animation-frame edit is silently lost.
    private var quarantinedContent: String?

    /// An exit that admits only one at a time (navigation) is running.
    private var isExiting = false
    /// An exit is holding the editor — navigation or a committing move.
    private(set) var isLockedForExit = false

    /// Reports "an exit holds the editor": the shell disables Back, the ⋯ menu,
    /// and the swipe strip on it so a second exit cannot start behind the first.
    /// A plain callback rather than an `ObservableObject` keeps this type free of
    /// UI-framework dependencies — the view mirrors it into its own `@State`.
    var onInteractionLockChanged: (Bool) -> Void = { _ in }

    /// `nonisolated` so a SwiftUI view can hold one in `@State` (whose property
    /// initializer runs outside the main actor).
    nonisolated init() {}

    // MARK: - The workflow registry

    /// Schedule `kind`'s next run. The previous task of that kind is cancelled
    /// and awaited first, so consecutive requests form ONE chain — awaiting the
    /// newest waits for every older one too. The body is skipped when the chain
    /// was cancelled or the session has closed.
    @discardableResult
    func schedule(
        _ kind: EditorWork,
        _ body: @escaping @MainActor () async -> Bool
    ) -> Task<Bool, Never> {
        let previous = work[kind]
        previous?.cancel()
        let task = Task { @MainActor [weak self] in
            _ = await previous?.value
            guard let self, self.isActive else { return false }
            return await body()
        }
        work[kind] = task
        return task
    }

    /// Whether the current task may still touch the note: not cancelled, and no
    /// destructive exit has latched. Re-check after every suspension.
    var isActive: Bool {
        !Task.isCancelled && !isClosing
    }

    func cancel(_ kind: EditorWork) {
        work[kind]?.cancel()
    }

    /// Cancel and await one workflow before another owner gathers facts that
    /// must describe settled disk. Open-note reconciliation uses this for the
    /// debounced draft flush: cancelling without the drain would let its FFI
    /// mutation land after the reconciler's disk read.
    func cancelAndDrain(_ kind: EditorWork) async {
        let pending = work[kind]
        pending?.cancel()
        _ = await pending?.value
    }

    /// The fifth way a note ends: it was deleted underneath us. A peer delete
    /// adopted by live sync leaves nothing to drain and nothing to commit — the
    /// file is already gone — so the session only has to make sure no pending
    /// workflow resurrects it. Latching closed does that for everything queued;
    /// the two workflows that WRITE are cancelled outright.
    func closeForExternalDelete() {
        cancel(.save)
        cancel(.rename)
        isClosing = true
    }

    // MARK: - Editor change admission

    /// What an editor change event may do right now.
    func disposition(loaded: Bool) -> EditorChangeDisposition {
        if !loaded { return .ignore }
        return isClosing ? .quarantine : .apply
    }

    /// Hold a change that arrived after the session latched closed.
    func quarantine(_ content: String) {
        quarantinedContent = content
    }

    /// Take the quarantined change, if any, clearing it.
    func takeQuarantined() -> String? {
        let content = quarantinedContent
        quarantinedContent = nil
        return content
    }

    /// Whether leaving the screen should flush the draft: only a loaded, dirty
    /// editor that is not already being torn down by its own delete.
    func shouldFlushOnLeave(loaded: Bool, content: String, savedContent: String) -> Bool {
        loaded && !isClosing && content != savedContent
    }

    // MARK: - The one exit verb

    /// Admission, latches, cancels, drain, commit, effect — for every way out.
    ///
    /// Deliberately NOT `async`: the latches and cancels have to land between
    /// the user's tap and the first suspension, which is exactly the window a
    /// queued save or a second Back used to slip through.
    ///
    /// Returns the drain task (nil when the exit was refused) so a caller — in
    /// practice only the tests — can await the whole exit.
    @discardableResult
    func end(_ exit: EditorExit, effects: EditorExitEffects) -> Task<Bool, Never>? {
        let plan = EditorExitPlan.of(exit)

        if plan.admitsOne {
            guard !isExiting, !isClosing else { return nil }
        }
        if plan.closes {
            guard !isClosing else { return nil }
        }

        // Snapshot the handles BEFORE this exit registers its own task under
        // `registersAs`, so a drain can never await itself.
        var drained: [EditorWork: Task<Bool, Never>] = [:]
        for kind in plan.drains { drained[kind] = work[kind] }

        for kind in plan.cancelsBeforeDrain { work[kind]?.cancel() }
        if plan.closes {
            isClosing = true
            quarantinedContent = nil
        }
        if plan.admitsOne { isExiting = true }
        if plan.locksInteraction {
            isLockedForExit = true
            onInteractionLockChanged(true)
        }
        effects.prepare()

        let task = Task { @MainActor [weak self] in
            var results: [EditorWork: Bool] = [:]
            for kind in plan.drains {
                if let pending = drained[kind] {
                    results[kind] = await pending.value
                }
            }
            guard let self else { return false }
            guard !Task.isCancelled, plan.closes || !self.isClosing else {
                self.release(plan, left: false)
                return false
            }

            if plan.commitsTitle {
                var committed = results[.rename] ?? true
                if !committed { committed = await effects.commitTitle() }
                guard committed else {
                    self.release(plan, left: false)
                    effects.onFailed(.title, nil, nil)
                    return false
                }
            }

            var committedBody: String?
            if plan.commitsBody {
                // The debounced save is neutralised HERE, not at admission: a
                // save already running has to finish (and be projected) before
                // the exit captures, or the capture races the write it is
                // supposed to supersede.
                let pendingSave = self.work[.save]
                pendingSave?.cancel()
                _ = await pendingSave?.value

                guard let captured = await effects.captureBody() else {
                    let late = self.takeQuarantined()
                    self.release(plan, left: false)
                    effects.onFailed(.capture, late, nil)
                    return false
                }
                // A change that landed while the capture was in flight is newer
                // than the capture, so it wins.
                var body = captured
                if plan.drainsQuarantine, let late = self.takeQuarantined() { body = late }
                while true {
                    guard await effects.commitBody(body) else {
                        let late = self.takeQuarantined()
                        self.release(plan, left: false)
                        effects.onFailed(.body, late, body)
                        return false
                    }
                    guard plan.drainsQuarantine, let later = self.takeQuarantined() else { break }
                    body = later
                }
                committedBody = body
            }

            let performed = await effects.perform(committedBody)
            self.release(plan, left: performed)
            if performed {
                effects.onSucceeded()
            } else {
                effects.onFailed(.action, self.takeQuarantined(), committedBody)
            }
            return performed
        }

        if let register = plan.registersAs { work[register] = task }
        return task
    }

    /// Release whatever this exit latched. A refused exit must leave the editor
    /// usable and the exit retryable.
    private func release(_ plan: EditorExitPlan, left: Bool) {
        if plan.admitsOne { isExiting = false }
        if plan.locksInteraction {
            isLockedForExit = false
            onInteractionLockChanged(false)
        }
        if plan.closes, !left { isClosing = false }
    }
}

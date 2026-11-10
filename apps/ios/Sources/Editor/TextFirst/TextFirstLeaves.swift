#if FUTO_DEBUG_BUILD
    import Foundation
    import UIKit

    /// A note has one editor attachment, so opening it again first settles the previous screen's
    /// leave (save + detach). A leave that cannot save never ends: the attachment is the draft
    /// (dropping a session that did not close loses its edits, like a crash), so the leave keeps
    /// the real controller and hands it back, draft and all, when the note is opened again. It
    /// ends on a durable save, on the user's Discard, or when a full reset retires the draft.
    ///
    /// From `leave` on this registry owns ALL saving for the draft: the controller's own timer is
    /// cancelled and cannot re-arm (`yieldSaving`), so each leave has one retry loop, one owner
    /// and one voice (the failure is told once, never through the screen that left).
    @MainActor
    enum TextFirstLeaves {
        /// How the retry loops pace themselves (tests substitute their own).
        struct Pacing {
            /// Pause before the second attempt; each further failure doubles it up to `cap`.
            var base: UInt64 = 2_000_000_000
            var cap: UInt64 = 60_000_000_000
            /// How a loop waits; a claim or a background kick ends the wait early.
            var sleep: @MainActor (UInt64) async -> Void = {
                try? await Task.sleep(nanoseconds: $0)
            }
            /// Background time for the attempt the app makes as it leaves the foreground.
            var background = BackgroundTaskProvider.system
        }
        static var pacing = Pacing()

        /// One leave that has not finished: the controller it owns and the task retrying it.
        @MainActor
        private final class Entry {
            let controller: TextFirstEditorController
            let store: NotesStore
            let ownerToken: UInt64
            let discardIfEmpty: Bool
            let originalId: String
            /// A title typed on the screen that its debounced rename had not committed yet, and
            /// that rename if it was already under way (it finishes first).
            let pendingTitle: String?
            let renaming: Task<Void, Never>?
            var task: Task<Void, Never>?
            /// The loop's wait between attempts.
            var nap: Task<Void, Never>?
            /// The note is being opened again: the loop stops (after the attempt in flight) and
            /// stays registered, `parked`, until the screen takes the controller or declines it.
            var claimed = false
            var parked = false
            /// A full reset retired the draft: nothing may be written or reported any more.
            var ended = false
            var failures = 0
            var lease: EditorBackgroundLease?
            init(
                controller: TextFirstEditorController, store: NotesStore, ownerToken: UInt64,
                discardIfEmpty: Bool, originalId: String, pendingTitle: String?,
                renaming: Task<Void, Never>?
            ) {
                self.controller = controller
                self.store = store
                self.ownerToken = ownerToken
                self.discardIfEmpty = discardIfEmpty
                self.originalId = originalId
                self.pendingTitle = pendingTitle
                self.renaming = renaming
            }

            func startLease() {
                guard lease == nil else { return }
                let provider = TextFirstLeaves.pacing.background
                let lease = EditorBackgroundLease(provider)
                lease.handle = provider.begin("text-first-leave") { lease.end() }
                self.lease = lease
            }

            func endLease() {
                lease?.end()
                lease = nil
            }
        }

        private static var entries: [Entry] = []
        private static var observers: [NSObjectProtocol] = []

        /// Leaves still saving or still failing.
        static var unsettled: Int { entries.count }

        /// The pause after `failures` failed attempts: 2 s, 4 s, 8 s ... capped.
        static func delay(afterFailures failures: Int) -> UInt64 {
            let doublings = UInt64(min(max(failures - 1, 0), 20))
            return min(pacing.cap, pacing.base << doublings)
        }

        /// The controller of a leave of `id` that could not save, for the screen opening the note
        /// again; nil once no leave of it is left (a leave that is still saving is awaited, and
        /// its release is what lets a fresh attachment open). `id` is matched against the
        /// attachment's own id, which a peer's rename or a parked conflict may have moved.
        ///
        /// The handover is one synchronous step. `accept` mounts the controller on the screen, or
        /// refuses because that screen left while this waited; only after it accepts does the
        /// registry let go and the screen's saving resume. A refused draft stays with its leave.
        static func claim(
            _ id: String,
            accept: @MainActor (TextFirstEditorController) -> Bool = { _ in true }
        ) async -> TextFirstEditorController? {
            for entry in entries { await entry.controller.refreshIdentity() }
            while let entry = entries.first(where: { $0.controller.noteId == id }) {
                entry.claimed = true
                entry.nap?.cancel()
                await entry.task?.value
                // Saved, or ended by a reset, while it was stopping: nothing left to take.
                guard entries.contains(where: { $0 === entry }) else { continue }
                // Another claim declined it and the loop went on: wait for that loop to stop too.
                guard entry.parked else { continue }
                guard accept(entry.controller) else {
                    entry.claimed = false
                    entry.parked = false
                    run(entry)
                    return nil
                }
                release(entry)
                entry.controller.resumeSaving()
                return entry.controller
            }
            return nil
        }

        /// Save and detach `controller` after its screen left. `discardIfEmpty` is a new note
        /// that was never touched (`originalId` is the id it started with: a note whose identity
        /// moved is not untouched). The screen's draft ownership (`ownerToken`) ends only once
        /// the draft is durable, handed back, or the store retires the token (a full reset ends
        /// the leave at once: writing the draft then would bring a wiped note back).
        /// `pendingTitle` is a typed title the screen had not renamed to yet: it commits first, as
        /// a title does when the screen is popped (nav.md).
        static func leave(
            controller: TextFirstEditorController, store: NotesStore, ownerToken: UInt64,
            discardIfEmpty: Bool, originalId: String, pendingTitle: String? = nil,
            renaming: Task<Void, Never>? = nil
        ) {
            controller.yieldSaving()
            // The screen is gone: nothing about this draft is reported through it again.
            controller.onFailure = nil
            controller.onIdentityChange = nil
            let entry = Entry(
                controller: controller, store: store, ownerToken: ownerToken,
                discardIfEmpty: discardIfEmpty, originalId: originalId, pendingTitle: pendingTitle,
                renaming: renaming)
            entries.append(entry)
            store.whenRetired(token: ownerToken) { end(entry) }
            observeBackgrounding()
            run(entry)
        }

        private static func run(_ entry: Entry) {
            entry.task = Task { @MainActor in
                let controller = entry.controller
                let store = entry.store
                // The screen's rename may still be running: let it land before naming anything.
                await entry.renaming?.value
                // A peer's rename or a park since the last save moved the attachment; nothing
                // below may name the old id.
                await controller.refreshIdentity()
                if let title = entry.pendingTitle, !entry.ended, store.ownsDraft(entry.ownerToken),
                    await TextFirstTitle.rename(
                        to: title, controller: controller, store: store,
                        ownerToken: entry.ownerToken) == .failed
                {
                    store.showTransient(LocalizedMessage("notes.title.renameFailed"))
                }
                while !entry.ended {
                    guard store.ownsDraft(entry.ownerToken) else { return end(entry) }
                    if entry.claimed {
                        entry.parked = true
                        return
                    }
                    let result = await controller.close()
                    if entry.ended { return }
                    switch result {
                    case .success(let saved):
                        if let mutation = saved.mutation { store.applyEditorMutation(mutation) }
                        if entry.discardIfEmpty, controller.noteId == entry.originalId,
                            controller.isEmpty
                        {
                            _ = await store.delete(controller.noteId)
                        }
                        return finish(entry)
                    case .failure(let error)
                    where error is TextFirstNeverOpened || error is TextFirstDiscarded:
                        // Nothing was attached, or the draft was discarded: nothing to keep.
                        return finish(entry)
                    case .failure(let error):
                        entry.failures += 1
                        entry.endLease()
                        print(
                            "text-first: detach \(controller.noteId) failed (\(entry.failures)): \(error)"
                        )
                        if entry.failures == 1 {
                            store.showTransient(LocalizedMessage("notes.save.failedPending"))
                        }
                        if entry.claimed { continue }
                        let pause = delay(afterFailures: entry.failures)
                        entry.nap = Task { await pacing.sleep(pause) }
                        await entry.nap?.value
                        entry.nap = nil
                    }
                }
            }
        }

        /// The app is leaving the foreground: attempt every pending leave now instead of waiting
        /// out its backoff, under background time that ends with the attempt.
        static func flushForBackground() {
            for entry in entries where !entry.claimed && !entry.ended {
                entry.startLease()
                entry.nap?.cancel()
            }
        }

        private static func observeBackgrounding() {
            guard observers.isEmpty else { return }
            for name in [
                UIApplication.willResignActiveNotification,
                UIApplication.didEnterBackgroundNotification,
            ] {
                observers.append(
                    NotificationCenter.default.addObserver(
                        forName: name, object: nil, queue: .main
                    ) { _ in
                        MainActor.assumeIsolated { flushForBackground() }
                    })
            }
        }

        /// The draft is durable (or has nothing to keep): the leave is over.
        private static func finish(_ entry: Entry) { release(entry) }

        /// A full reset retired the draft: stop at once and let it go unwritten.
        private static func end(_ entry: Entry) {
            guard !entry.ended else { return }
            entry.ended = true
            entry.nap?.cancel()
            entry.controller.discard()
            release(entry)
        }

        private static func release(_ entry: Entry) {
            entry.endLease()
            entries.removeAll { $0 === entry }
            entry.store.releaseDraftOwnership(token: entry.ownerToken)
        }
    }

    extension TextFirstEditorController {
        var isEmpty: Bool { mirrorLength == 0 }
    }
#endif

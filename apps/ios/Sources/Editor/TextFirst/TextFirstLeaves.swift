#if FUTO_DEBUG_BUILD
    import Foundation

    /// A note has one editor attachment, so opening it again first settles the previous screen's
    /// leave (save + detach). A leave that cannot save never ends: the attachment is the draft
    /// (dropping a session that did not close loses its edits, like a crash), so the leave keeps
    /// the real controller, keeps retrying, and hands it back, draft and all, when the note is
    /// opened again. It ends only on a durable save or when the user discards the draft.
    @MainActor
    enum TextFirstLeaves {
        /// Pause between detach attempts (tests shorten it).
        static var retryNanoseconds: UInt64 = 2_000_000_000

        /// One leave that has not finished: the controller it owns and the task retrying it.
        private final class Entry {
            let controller: TextFirstEditorController
            let store: NotesStore
            let ownerToken: UInt64
            var task: Task<Void, Never>?
            /// The note is being opened again: stop retrying and give the controller back.
            var handBack = false
            var handedBack: TextFirstEditorController?
            var failures = 0
            init(controller: TextFirstEditorController, store: NotesStore, ownerToken: UInt64) {
                self.controller = controller
                self.store = store
                self.ownerToken = ownerToken
            }
        }

        private static var entries: [Entry] = []

        /// Leaves still saving or still failing.
        static var unsettled: Int { entries.count }

        /// The controller of a leave of `id` that could not save, for the screen opening the note
        /// again; nil once no leave of it is left (a leave that is still saving is awaited, and
        /// its release is what lets a fresh attachment open). `id` is matched against the
        /// attachment's own id, which a peer's rename or a parked conflict may have moved.
        static func claim(_ id: String) async -> TextFirstEditorController? {
            for entry in entries { await entry.controller.refreshIdentity() }
            while let entry = entries.first(where: { $0.controller.noteId == id }) {
                entry.handBack = true
                entry.task?.cancel()
                await entry.task?.value
                if let controller = entry.handedBack { return controller }
            }
            return nil
        }

        /// Save and detach `controller` after its screen left. `discardIfEmpty` is a new note
        /// that was never touched (`originalId` is the id it started with: a note whose identity
        /// moved is not untouched). The screen's draft ownership (`ownerToken`) ends only once
        /// the draft is durable, handed back, or the store no longer honours the token (a full
        /// reset retires every draft: writing one then would bring a wiped note back).
        static func leave(
            controller: TextFirstEditorController, store: NotesStore, ownerToken: UInt64,
            discardIfEmpty: Bool, originalId: String
        ) {
            let entry = Entry(controller: controller, store: store, ownerToken: ownerToken)
            entries.append(entry)
            entry.task = Task { @MainActor in
                // A peer's rename or a park since the last save moved the attachment; nothing
                // below may name the old id.
                await controller.refreshIdentity()
                while true {
                    guard store.ownsDraft(ownerToken) else {
                        controller.discard()
                        return finish(entry)
                    }
                    switch await controller.close() {
                    case .success(let saved):
                        if let mutation = saved.mutation { store.applyEditorMutation(mutation) }
                        if discardIfEmpty, controller.noteId == originalId, controller.isEmpty {
                            _ = await store.delete(controller.noteId)
                        }
                        finish(entry)
                        return
                    case .failure(let error) where error is TextFirstNeverOpened:
                        // The engine never attached: nothing was typed into it, nothing to keep.
                        finish(entry)
                        return
                    case .failure(let error):
                        entry.failures += 1
                        print(
                            "text-first: detach \(controller.noteId) failed (\(entry.failures)): \(error)"
                        )
                        if entry.failures == 1 {
                            store.showTransient(LocalizedMessage("notes.save.failedPending"))
                        }
                        if entry.handBack { return handBack(entry) }
                        try? await Task.sleep(nanoseconds: retryNanoseconds)
                        if entry.handBack { return handBack(entry) }
                    }
                }
            }
        }

        private static func finish(_ entry: Entry) {
            entries.removeAll { $0 === entry }
            entry.store.releaseDraftOwnership(token: entry.ownerToken)
        }

        private static func handBack(_ entry: Entry) {
            entry.handedBack = entry.controller
            finish(entry)
        }
    }

    extension TextFirstEditorController {
        var isEmpty: Bool { mirrorLength == 0 }
    }
#endif

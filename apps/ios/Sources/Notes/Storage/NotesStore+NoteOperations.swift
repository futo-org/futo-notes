import Foundation

extension NotesStore {
    func read(_ id: String) async throws -> String {
        do {
            return try await vault.read(id)
        } catch {
            print("read note failed for \(id): \(error)")
            throw error
        }
    }
    func readIfExists(_ id: String) async throws -> String? {
        do {
            return try await vault.readIfExists(id)
        } catch {
            print("read existing note failed for \(id): \(error)")
            throw error
        }
    }

    func write(_ id: String, content: String, ownerToken: UInt64? = nil) async
        -> NoteMutationOutcome<Void>
    {
        let epoch = resetEpoch
        guard ownsDraft(ownerToken) else { return .failed }
        do {
            let retainedAtAdmission = retainedDraftSnapshot(for: id)
            applyMutation(
                try await vault.write(id, content: content, epoch: epoch), expectedEpoch: epoch)
            completeRetainedDraftSnapshot(retainedAtAdmission)
            onLocalChange?()
            return .committed(())
        } catch {
            print("write failed for \(id): \(error)")
            showTransient(LocalizedMessage("notes.save.failedPending"))
            return .failed
        }
    }

    /// Create a new note. Returns its id, or nil on failure.
    @discardableResult
    func createNote(title: String, folder: String = "") async -> String? {
        let epoch = resetEpoch
        guard !resetting else { return nil }
        do {
            let mutation = try await vault.createNote(title: title, folder: folder, epoch: epoch)
            applyMutation(mutation, expectedEpoch: epoch)
            let createdId = mutation.finalId ?? title
            editorDraftCoordinator.reopen(createdId)
            onLocalChange?()
            return createdId
        } catch {
            print("createNote failed: \(error)")
            return nil
        }
    }

    func delete(_ id: String, ownerToken: UInt64? = nil) async -> NoteMutationOutcome<Void> {
        let epoch = resetEpoch
        guard ownsDraft(ownerToken) else { return .failed }
        let identity = editorDraftCoordinator.beginIdentityMutation(id)
        let pendingFlushes = editorDraftTail
        do {
            await pendingFlushes?.value
            guard ownsDraft(ownerToken) else { return .failed }
            applyMutation(try await vault.delete(id, epoch: epoch), expectedEpoch: epoch)
            discardDrafts(for: id)
            editorDraftCoordinator.finishIdentityMutation(identity, committed: true)
            onLocalChange?()
            return .committed(())
        } catch {
            editorDraftCoordinator.finishIdentityMutation(identity, committed: false)
            print("delete failed for \(id): \(error)")
            return .failed
        }
    }

    func deleteAsync(_ id: String, ownerToken: UInt64? = nil) {
        if let ownerToken, ownerToken <= retiredDraftTokensThrough { return }
        Task {
            _ = await delete(id, ownerToken: ownerToken)
        }
    }

    @discardableResult
    func rename(
        oldId: String, newId: String, draft: PendingDraft? = nil, ownerToken: UInt64? = nil
    ) async -> NoteMutationOutcome<CommittedNote> {
        let epoch = resetEpoch
        guard ownsDraft(ownerToken) else { return .failed }
        let identity = editorDraftCoordinator.beginIdentityMutation(oldId)
        let pendingFlushes = editorDraftTail
        do {
            await pendingFlushes?.value
            guard ownsDraft(ownerToken) else { return .failed }
            let mutation: NoteMutation
            if let draft {
                mutation = try await vault.saveDraftAs(draft, wantedId: newId, epoch: epoch)
            } else {
                mutation = try await vault.rename(oldId: oldId, newId: newId, epoch: epoch)
            }
            let finalId = mutation.finalId ?? oldId
            applyMutation(mutation, expectedEpoch: epoch)
            retargetRetainedDrafts(from: oldId, to: finalId)
            editorDraftCoordinator.finishIdentityMutation(identity, committed: true)
            editorDraftCoordinator.reopen(finalId)
            onLocalChange?()
            return .committed(CommittedNote(id: finalId, relinkedBody: mutation.finalBody))
        } catch {
            editorDraftCoordinator.finishIdentityMutation(identity, committed: false)
            print("rename failed \(oldId) -> \(newId): \(error)")
            return .failed
        }
    }

    /// Flush a pending draft through the engine's ONE draft-saving verb
    /// (persist-or-park, ADR-0001 / issue #37) and project the returned
    /// mutation. The engine decides the disposition — wrote / converged /
    /// recreated at the original id (edit-wins dirty-keep, sync.md — the same
    /// home the resume autosave rewrites, so the survive and jetsam paths
    /// converge with no duplicate copy) / parked as a conflict copy (the
    /// diverged note untouched, the edit surviving as a new note). The whole
    /// composition runs under the engine's serialization, so the old
    /// cross-FFI check-then-act windows (PKT-10 P1a/P1b) and the hand-rolled
    /// per-platform state machine are gone. Returns the disposition (nil on
    /// an I/O failure) so the live-pull conflict path can react; iOS remains
    /// the shell that never drops a draft (Android drops on skip until #38).
    @discardableResult
    func flushDraft(_ draft: PendingDraft, ownerToken: UInt64? = nil) async -> FlushDisposition? {
        guard ownsDraft(ownerToken) else { return nil }
        guard !resetting else { return nil }
        return await flushDraftDirect(draft)
    }

    private func flushDraftDirect(_ draft: PendingDraft) async -> FlushDisposition? {
        let epoch = resetEpoch
        do {
            let result = try await vault.flushDraft(
                draft.id, base: draft.base, content: draft.content, epoch: epoch)
            // Converged and already-parked outcomes carry no mutation —
            // nothing changed on disk, nothing to project or sync.
            if let mutation = result.mutation {
                applyMutation(mutation, expectedEpoch: epoch)
                onLocalChange?()
            }
            return result.disposition
        } catch {
            print("flush failed for \(draft.id): \(error)")
            return nil
        }
    }

    /// Fire-and-forget flush for contexts that cannot `await` —
    /// `NoteEditorView.onDisappear` (pop) and the app's scenePhase background
    /// handler (the F8 jetsam guard).
    func waitForEditorFlushes() async { await editorDraftTail?.value }

    func flushRetainedEditor(_ draft: PendingDraft, ownerToken: UInt64) {
        publishDraft(token: ownerToken, draft)
        retainDraftUntilFlushed(token: ownerToken)
        flushAsync(draft, ownerToken: ownerToken)
    }

    func flushAsync(_ draft: PendingDraft, ownerToken: UInt64? = nil) {
        if let ownerToken, ownerToken <= retiredDraftTokensThrough { return }
        guard let admission = editorDraftCoordinator.admit(draft.id) else { return }
        let previous = editorDraftTail
        editorDraftTail = Task { @MainActor in
            await previous?.value
            guard editorDraftCoordinator.permits(admission) else { return }
            if await flushDraftDirect(draft) != nil {
                completeRetainedDraft(draft)
            }
        }
    }

    func moveNote(
        _ id: String, toFolder folder: String, draft: PendingDraft? = nil, ownerToken: UInt64? = nil
    ) async -> NoteMutationOutcome<CommittedNote> {
        let epoch = resetEpoch
        guard ownsDraft(ownerToken) else { return .failed }
        let identity = editorDraftCoordinator.beginIdentityMutation(id)
        let pendingFlushes = editorDraftTail
        do {
            await pendingFlushes?.value
            guard ownsDraft(ownerToken) else { return .failed }
            let mutation: NoteMutation
            if let draft {
                mutation = try await vault.moveDraft(draft, folder: folder, epoch: epoch)
            } else {
                mutation = try await vault.moveNote(id, folder: folder, epoch: epoch)
            }
            let finalId = mutation.finalId ?? id
            applyMutation(mutation, expectedEpoch: epoch)
            retargetRetainedDrafts(from: id, to: finalId)
            editorDraftCoordinator.finishIdentityMutation(identity, committed: true)
            editorDraftCoordinator.reopen(finalId)
            onLocalChange?()
            return .committed(CommittedNote(id: finalId, relinkedBody: mutation.finalBody))
        } catch {
            editorDraftCoordinator.finishIdentityMutation(identity, committed: false)
            print("moveNote failed \(id) -> \(folder): \(error)")
            return .failed
        }
    }
}

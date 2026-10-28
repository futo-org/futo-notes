import Foundation

/// The only native owner of the Rust local-note store. Every blocking FFI call
/// runs on this actor, never on the main actor.
actor NoteVault {
    /// `nonisolated(unsafe)`: the UniFFI handle is thread-safe (the Rust
    /// object is Send + Sync), and `waitUntilSearchReady` must reach it
    /// without queueing on this actor. Every other use stays actor-isolated.
    nonisolated(unsafe) private let core: NoteStore

    private var generation: UInt64 = 0
    private func requireGeneration(_ epoch: UInt64) throws {
        guard epoch == generation else { throw NSError(domain: "NotesStore", code: 1) }
    }

    init(notesRoot: String) {
        core = NoteStore(notesRoot: notesRoot)
    }

    func bootstrap(indexDir: String, order: NoteSortOrder) throws -> NoteBootstrap {
        try core.bootstrap(indexDir: indexDir, order: order)
    }

    func setSortOrder(_ order: NoteSortOrder) throws -> NoteSnapshot {
        try core.setSortOrder(order: order)
    }

    func scan() -> NoteSnapshot { core.scan() }
    /// A missing note reads as empty; one that exists but cannot be decoded
    /// throws, so it never opens as a blank page.
    func read(_ id: String) throws -> String { try core.read(id: id) }
    func exists(_ id: String) -> Bool { core.exists(id: id) }
    func readIfExists(_ id: String) throws -> String? {
        return try core.readIfExists(id: id)
    }

    func refreshExternalChanges(_ summary: SyncSummary) throws -> NoteMutation {
        return try core.refreshExternalChanges(
            updatedIds: summary.updatedIds,
            deletedIds: summary.deletedIds,
            renamed: summary.renamed
        )
    }

    func write(_ id: String, content: String, epoch: UInt64) throws -> NoteMutation {
        try requireGeneration(epoch)
        return try core.write(id: id, content: content)
    }

    /// THE draft-saving verb (persist-or-park, ADR-0001 / issue #37): the
    /// engine resolves every save surprise itself — wrote / converged /
    /// recreated at the original id / parked as a conflict copy — under its
    /// own per-workflow serialization, and returns the disposition plus the
    /// mutation to project. This replaced the Swift-side
    /// writeIfUnchanged → createIfAbsent → park composition, whose
    /// check-then-act windows spanned FFI calls (PKT-10 P1a/P1b).
    func flushDraft(_ id: String, base: String, content: String, epoch: UInt64) throws
        -> FlushDraftResult
    {
        try requireGeneration(epoch)
        return try core.flushDraft(id: id, base: base, content: content)
    }

    func saveDraftAs(_ draft: PendingDraft, wantedId: String, epoch: UInt64) throws -> NoteMutation
    {
        try requireGeneration(epoch)
        return try core.saveDraftAs(
            id: draft.id, wantedId: wantedId, base: draft.base, content: draft.content
        )
    }

    func moveDraft(_ draft: PendingDraft, folder: String, epoch: UInt64) throws -> NoteMutation {
        try requireGeneration(epoch)
        return try core.moveDraft(
            id: draft.id, folder: folder, base: draft.base, content: draft.content
        )
    }

    func createNote(title: String, folder: String, epoch: UInt64) throws -> NoteMutation {
        try requireGeneration(epoch)
        return try core.createNote(title: title, folder: folder, content: "")
    }

    func delete(_ id: String, epoch: UInt64) throws -> NoteMutation {
        try requireGeneration(epoch)
        return try core.delete(id: id)
    }

    func rename(oldId: String, newId: String, epoch: UInt64) throws -> NoteMutation {
        try requireGeneration(epoch)
        return try core.rename(oldId: oldId, newId: newId)
    }

    func moveNote(_ id: String, folder: String, epoch: UInt64) throws -> NoteMutation {
        try requireGeneration(epoch)
        return try core.moveNote(id: id, folder: folder)
    }

    func createFolder(_ path: String, epoch: UInt64) throws -> NoteMutation {
        try requireGeneration(epoch)
        return try core.createFolder(path: path)
    }

    func renameFolder(from: String, to: String, epoch: UInt64) throws -> NoteMutation {
        try requireGeneration(epoch)
        return try core.renameFolder(from: from, to: to)
    }

    func moveFolder(from: String, destinationParent: String, epoch: UInt64) throws -> NoteMutation {
        try requireGeneration(epoch)
        return try core.moveFolder(from: from, destinationParent: destinationParent)
    }

    func deleteFolder(_ folder: String, epoch: UInt64) throws -> NoteMutation {
        try requireGeneration(epoch)
        return try core.deleteFolder(folder: folder)
    }

    func search(_ query: String, limit: UInt32) throws -> [SearchHit] {
        return try core.search(query: query, limit: limit)
    }

    /// The engine wait blocks, so run it on overcommitting GCD rather than the
    /// Swift cooperative pool. `nonisolated` keeps it off the note-workflow
    /// actor queue (see `SearchReadinessWaitTests`).
    nonisolated func waitUntilSearchReady(timeoutMs: UInt64) async -> Bool {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async { [core] in
                continuation.resume(returning: core.waitUntilSearchReady(timeoutMs: timeoutMs))
            }
        }
    }

    /// Error recovery only. Normal sync projection is the scoped engine verb.
    func recoveryScan() -> NoteSnapshot {
        core.rescan()
        return core.scan()
    }

    func reset(epoch: UInt64) throws {
        generation = epoch
        try core.reset()
    }
}

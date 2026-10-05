import Foundation
import Testing

@testable import FutoNotesNative

@Suite @MainActor
struct RetainedEditorDraftTests {
    @Test func failedLateWriteRemainsRegisteredUntilLifecycleRetryIsDurable() async throws {
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(
            UUID().uuidString)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }
        let root = scratch.appendingPathComponent("notes")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = NotesStore(
            notesRoot: root, searchIndex: scratch.appendingPathComponent("index"))
        while !store.hasBootstrapped { await Task.yield() }
        let obstruction = root.appendingPathComponent("blocked")
        try Data("not a directory".utf8).write(to: obstruction)
        let token = store.claimDraftOwnership()
        let draft = PendingDraft(id: "blocked/note", base: "", content: "late typed tail")
        store.flushRetainedEditor(draft, ownerToken: token)
        await store.waitForEditorFlushes()
        // The first write failed. Retry comes only from the retained register.
        try FileManager.default.removeItem(at: obstruction)
        store.flushPendingEditor()
        await store.waitForEditorFlushes()
        #expect(try await store.read("blocked/note") == "late typed tail")
        // A completed one-shot draft is gone and cannot recreate a deleted file.
        try FileManager.default.removeItem(at: root.appendingPathComponent("blocked/note.md"))
        store.rearmBackgroundFlush()
        store.flushPendingEditor()
        await store.waitForEditorFlushes()
        #expect(
            !FileManager.default.fileExists(
                atPath: root.appendingPathComponent("blocked/note.md").path))
    }
}

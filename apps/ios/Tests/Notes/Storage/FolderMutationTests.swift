import Foundation
import Testing

@testable import FutoNotesNative

@MainActor
@Suite("NotesStore folder mutations")
struct FolderMutationTests {
    private static func bootstrappedStore() async throws -> (NotesStore, URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("folder-mutations-\(UUID().uuidString)", isDirectory: true)
        let notes = root.appendingPathComponent("notes", isDirectory: true)
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
        let store = NotesStore(
            notesRoot: notes, searchIndex: root.appendingPathComponent("index", isDirectory: true))
        for _ in 0..<500 where !store.hasBootstrapped {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(store.hasBootstrapped)
        return (store, root)
    }

    // An agent's folder create answered before the folder existed, so a move into it
    // straight afterwards was refused `no such folder`.
    @Test("create and delete return once the folder list has the change")
    func returnsOnceApplied() async throws {
        let (store, root) = try await Self.bootstrappedStore()
        defer { try? FileManager.default.removeItem(at: root) }

        #expect(await store.createFolder("errands"))
        #expect(store.folders.contains("errands"))
        #expect(await store.deleteFolder("errands"))
        #expect(!store.folders.contains("errands"))
    }

    // A failed create answered 200 too, because the error was only printed.
    @Test("a create the vault refuses reports failure and changes nothing")
    func reportsRefusal() async throws {
        let (store, root) = try await Self.bootstrappedStore()
        defer { try? FileManager.default.removeItem(at: root) }
        // A plain file where the folder's parent must go makes create_dir_all fail.
        try Data().write(to: store.notesRoot.appendingPathComponent("blocker"))

        #expect(!(await store.createFolder("blocker/child")))
        #expect(!store.folders.contains("blocker/child"))
    }

    @Test("foreground refresh projects external additions, folder moves and deletions")
    func foregroundRefreshesExternalChanges() async throws {
        let (store, root) = try await Self.bootstrappedStore()
        defer { try? FileManager.default.removeItem(at: root) }
        #expect(await store.createFolder("before"))
        let note = try #require(await store.createNote(title: "note", folder: "before"))
        #expect(note == "before/note")
        try FileManager.default.moveItem(
            at: store.notesRoot.appendingPathComponent("before"),
            to: store.notesRoot.appendingPathComponent("after"))
        try "outside body".write(
            to: store.notesRoot.appendingPathComponent("added.md"), atomically: true,
            encoding: .utf8)

        await store.refreshAfterForeground()
        #expect(!store.folders.contains("before"))
        #expect(store.folders.contains("after"))
        #expect(!store.notes.contains { $0.id == "before/note" })
        #expect(store.notes.contains { $0.id == "after/note" })
        #expect(store.notes.contains { $0.id == "added" })

        try FileManager.default.removeItem(at: store.notesRoot.appendingPathComponent("added.md"))
        await store.refreshAfterForeground()
        #expect(!store.notes.contains { $0.id == "added" })
    }
}

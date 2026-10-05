import Foundation
import Testing

@testable import FutoNotesNative

/// The engine's one draft-saving verb (persist-or-park, ADR-0001 / issue #37)
/// exercised through the same `NoteVault` actor the app's flush paths ride —
/// this guards the FFI wiring `NotesStore.flushDraft` / `flushAsync` and the
/// live-pull conflict path now depend on, after the Swift-side
/// writeIfUnchanged → createIfAbsent → park state machine was deleted.
/// One disposition is enough to prove the actor reaches a real store and
/// decodes the result; every disposition is walked through the same exported
/// `NoteStore` by `flush_draft_projects_every_disposition`
/// (crates/futo-notes-ffi/tests/note_contract.rs).
@Suite("NoteVault flush_draft wiring")
struct FlushDraftVerbTests {
    private func makeVaultRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("flush-draft-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    @Test("reset rejects previously admitted writes even after new work resumes")
    func resetRetiresOldEpoch() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let vault = NoteVault(notesRoot: root.path)
        _ = try await vault.write("old", content: "old body", epoch: 0)
        try await vault.reset(epoch: 1)
        await #expect(throws: (any Error).self) {
            _ = try await vault.write("old", content: "late body", epoch: 0)
        }
        #expect(try await vault.read("old") == "")
        _ = try await vault.write("new", content: "new body", epoch: 1)
        #expect(try await vault.read("new") == "new body")
    }

    @Test("a draft whose base still matches disk is written")
    func writesOnMatchingBase() async throws {
        let root = try makeVaultRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let vault = NoteVault(notesRoot: root.path)
        _ = try await vault.write("note", content: "base text", epoch: 0)

        let result = try await vault.flushDraft(
            "note", base: "base text", content: "draft text", epoch: 0)

        #expect(result.disposition == .wrote)
        #expect(result.mutation?.finalId == "note")
        #expect(try await vault.read("note") == "draft text")
    }
}

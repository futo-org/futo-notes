import Foundation
import Testing

@testable import FutoNotesNative

/// The engine's one draft-saving verb (persist-or-park, ADR-0001 / issue #37)
/// exercised through the same `NoteVault` actor the app's flush paths ride —
/// this guards the FFI wiring `NotesStore.flushDraft` / `flushAsync` and the
/// live-pull conflict path now depend on, after the Swift-side
/// writeIfUnchanged → createIfAbsent → park state machine was deleted.
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
        #expect(await vault.read("old") == "")
        _ = try await vault.write("new", content: "new body", epoch: 1)
        #expect(await vault.read("new") == "new body")
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
        #expect(await vault.read("note") == "draft text")
    }

    @Test("a draft the disk already holds converges without a mutation")
    func convergesWithoutMutation() async throws {
        let root = try makeVaultRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let vault = NoteVault(notesRoot: root.path)
        _ = try await vault.write("note", content: "same text", epoch: 0)

        let result = try await vault.flushDraft(
            "note", base: "stale base", content: "same text", epoch: 0)

        #expect(result.disposition == .converged)
        #expect(result.mutation == nil)
    }

    @Test("a peer-deleted note is recreated at the original id with a positioned mutation")
    func recreatesAtOriginalId() async throws {
        let root = try makeVaultRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let vault = NoteVault(notesRoot: root.path)

        let result = try await vault.flushDraft(
            "Gone", base: "old base", content: "surviving draft", epoch: 0)

        #expect(result.disposition == .recreated)
        let mutation = try #require(result.mutation)
        #expect(mutation.finalId == "Gone")
        #expect(mutation.upserted.first?.position == 0)
        #expect(await vault.read("Gone") == "surviving draft")
    }

    @Test("a diverged draft is parked once — an identical re-park mints nothing")
    func parksDivergedDraftIdempotently() async throws {
        let root = try makeVaultRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let vault = NoteVault(notesRoot: root.path)
        _ = try await vault.write("note", content: "peer version", epoch: 0)

        let first = try await vault.flushDraft(
            "note", base: "original", content: "my draft", epoch: 0)

        guard case .parkedConflict(let parkedId) = first.disposition else {
            Issue.record("expected the diverged draft to be parked, got \(first.disposition)")
            return
        }
        #expect(parkedId.hasPrefix("note (conflict "))
        #expect(first.mutation != nil, "a fresh park projects a mutation")
        #expect(await vault.read("note") == "peer version", "diverged note untouched")
        #expect(await vault.read(parkedId) == "my draft")

        // The crash-window double-park (scenePhase flush firing at both .inactive
        // and .background): the identical draft reports the same copy, mints none.
        let again = try await vault.flushDraft(
            "note", base: "original", content: "my draft", epoch: 0)
        #expect(again.disposition == .parkedConflict(parkedId: parkedId))
        #expect(again.mutation == nil)
        #expect(await vault.scan().notes.count == 2, "original + exactly one copy")
    }
}

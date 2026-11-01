import Foundation
import Testing

@testable import FutoNotesNative

/// A real page-owned consumer; Markdown meaning and recovery stay in Rust.
@Suite("Native bounded editor session contract")
struct NativeBoundedEditorSessionTests {
    private static func vault(_ action: (NoteStore, URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "editor-bounded-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try action(NoteStore(notesRoot: root.path), root)
    }

    @Test("bounded page frames retain exact source, semantics, history and the same lease")
    func boundedTrace() async throws {
        try await Task.detached {
            try Self.vault { store, _ in
                let paragraph = "__😀__ &acE; [x](u) plain\n\n"
                let source =
                    "prefix\n\n```Rust\nab\n```\n\n" + String(repeating: paragraph, count: 8)
                _ = try store.createNote(title: "plain", folder: "", content: source)
                let full = try store.openEditor(id: "plain")
                _ = try full.replaceUtf16(
                    expected: 0, range: EditorUtf16Range(start: 8, end: 8), inserted: [122])
                var view = Array(try full.displayText().utf8)
                let bounded = try full.intoBounded(expected: 1, token: 86, bodyCaret: 8)
                do {
                    _ = try full.sourceText()
                    Issue.record("old full alias accepted")
                } catch EditorSessionError.Unavailable {}
                do {
                    _ = try store.openEditor(id: "plain")
                    Issue.record("bounded transfer released the lease")
                } catch EditorSessionError.SessionAlreadyOpen {}
                func apply(_ range: EditorByteRange, _ inserted: String) throws {
                    let start = try #require(Int(exactly: range.start))
                    let end = try #require(Int(exactly: range.end))
                    view.replaceSubrange(start..<end, with: inserted.utf8)
                }
                func apply(_ frame: EditorBoundedProgress) throws -> EditorProjectionContinuation? {
                    switch frame {
                    case .change(let change):
                        try apply(change.range, change.inserted)
                        #expect(change.work.parsedSourceBytes == 0)
                        #expect(change.conversion.records > 0)
                        return change.continuation
                    case .status(let status): return status.continuation
                    }
                }
                func finish(_ continuation: EditorProjectionContinuation?) throws {
                    var job = continuation
                    var steps = 0
                    while let next = job {
                        job = try apply(bounded.continueProjection(continuation: next))
                        steps += 1
                        #expect(steps < 32)
                    }
                }
                let initial = try bounded.cursor()
                do {
                    _ = try bounded.insertLiteral(cursor: initial, at: 0x1_0000_0000, scalar: 65)
                    Issue.record("wide offset accepted")
                } catch EditorBoundedError.Session(let error) {
                    guard case EditorSessionError.InvalidRange = error else { throw error }
                }
                do {
                    _ = try bounded.insertLiteral(cursor: initial, at: 8, scalar: 0xD800)
                    Issue.record("invalid scalar accepted")
                } catch EditorBoundedError.InvalidScalar {}
                #expect(try bounded.lastOperationWork().work.metadataItems == 0)
                #expect(try bounded.lastOperationWork().work.copiedBytes == 0)
                #expect(try bounded.cursor() == initial)
                let removed = try bounded.removeFenceCloser(cursor: initial)
                try apply(removed.range, removed.inserted)
                let stale = try #require(removed.continuation)
                let bytes = Array("plain".utf8)
                let far =
                    try #require(
                        view.indices.reversed().first {
                            $0 + bytes.count <= view.count
                                && Array(view[$0..<($0 + bytes.count)]) == bytes
                        }) + 2
                _ = try apply(
                    bounded.selectBounded(
                        cursor: bounded.cursor(),
                        range: EditorByteRange(start: UInt64(far), end: UInt64(far)),
                        affinity: .backward))
                do {
                    _ = try bounded.continueProjection(continuation: stale)
                    Issue.record("stale continuation accepted")
                } catch EditorBoundedError.StaleCursor {}
                #expect(try bounded.lastOperationWork().work.metadataItems == 0)
                let prefix = try bounded.insertPrefixLiteral(
                    cursor: bounded.cursor(), at: 1, scalar: 113)
                try apply(prefix.range, prefix.inserted)
                let code = try bounded.insertLiteral(
                    cursor: bounded.cursor(), at: 10, scalar: 0x1F600)
                #expect(try bounded.lastOperationWork().work.copiedBytes == code.work.copiedBytes)
                #expect(code.projection.block.owner == 9)
                #expect(code.selection == EditorByteRange(start: 14, end: 14))
                #expect(code.affinity == .backward)
                #expect(
                    code.projection.identity.source == EditorSourceByteRange(start: 18, end: 22))
                try apply(code.range, code.inserted)
                try finish(code.continuation)
                var job: EditorProjectionContinuation?
                for _ in 0..<3 {
                    job = try apply(#require(try bounded.undoBounded(cursor: bounded.cursor())))
                }
                var atom = false
                var hidden = false
                var link = false
                var steps = 0
                while let next = job {
                    let frame = try bounded.continueProjection(continuation: next)
                    if case .change(let change) = frame {
                        atom = atom || change.projection.mapping.contains { $0.kind == .atom }
                        hidden = hidden || change.projection.mapping.contains { $0.kind == .hidden }
                        link = link || change.projection.links.contains { $0.destination == "u" }
                    }
                    job = try apply(frame)
                    steps += 1
                    #expect(steps < 32)
                }
                #expect(atom && hidden && link)
                for _ in 0..<3 {
                    job = try apply(#require(try bounded.redoBounded(cursor: bounded.cursor())))
                }
                try finish(job)
                let expected =
                    "pqrefix\n\n```Rust\nz😀ab\n\n\n" + String(repeating: paragraph, count: 8)
                let copy = try bounded.acceptedSource()
                #expect(copy.source == expected && !copy.resetRequired && !copy.deleted)
                #expect(copy.conversion.copiedTextBytes == UInt64(expected.utf8.count))
                #expect(try bounded.recoveryFlushDelay() != nil)
                #expect(try bounded.flushRecovery().durable == copy.recovery.accepted)
                #expect(try bounded.recoveryFlushDelay() == nil)
                #expect(try !bounded.resumeRecovery().paused)
                let handoff = try bounded.intoFull()
                do {
                    _ = try bounded.cursor()
                    Issue.record("old bounded alias accepted")
                } catch EditorBoundedError.Unavailable {}
                #expect(try handoff.session.sourceText() == expected)
                #expect(try Array(handoff.session.displayText().utf8) == view)
                _ = try store.createNote(title: "oracle", folder: "", content: expected)
                let oracle = try store.openEditor(id: "oracle")
                let range = EditorByteRange(start: 0, end: UInt64(view.count))
                let revision = try handoff.session.revision()
                let actual = try handoff.session.project(expected: revision, range: range)
                var fresh = try oracle.project(expected: 0, range: range)
                fresh.revision = revision
                #expect(actual == fresh)
                try oracle.detach()
                for _ in 0..<4 {
                    _ = try #require(try handoff.session.undo(expected: handoff.session.revision()))
                }
                #expect(try handoff.session.sourceText() == source)
                try handoff.session.detach()
            }
        }.value
    }

    @Test("refused entry returns the same full composition and Undo owner")
    func refusedEntry() async throws {
        try await Task.detached {
            try Self.vault { store, _ in
                let source = "```\nab\n```\n"
                _ = try store.createNote(title: "plain", folder: "", content: source)
                let full = try store.openEditor(id: "plain")
                _ = try full.replaceUtf16(
                    expected: 0, range: EditorUtf16Range(start: 1, end: 1), inserted: [120])
                _ = try full.composeUtf16(
                    expected: 1, range: EditorUtf16Range(start: 2, end: 2), text: [109])
                do {
                    _ = try full.intoBounded(expected: 1, token: 87, bodyCaret: 1)
                    Issue.record("composition entry accepted")
                } catch EditorBoundedError.Session(let error) {
                    guard case EditorSessionError.CompositionActive = error else { throw error }
                }
                #expect(try full.lastBoundedOperationWork().work.metadataItems == 0)
                #expect(try full.composition()?.text == "m")
                #expect(try full.sourceText() == "```\naxb\n```\n")
                try full.cancelComposition(expected: 1)
                let bounded = try full.intoBounded(expected: 1, token: 87, bodyCaret: 1)
                let restored = try bounded.intoFull().session
                _ = try #require(try restored.undo(expected: 1))
                #expect(try restored.sourceText() == source)
                try restored.detach()
            }
        }.value
    }

    @Test("failed materialization and append preserve the bounded owner and accepted copy")
    func refusedMaterialization() async throws {
        try await Task.detached {
            try Self.vault { store, root in
                let source = "```\nab\n```\n"
                _ = try store.createNote(title: "plain", folder: "", content: source)
                let full = try store.openEditor(id: "plain")
                let bounded = try full.intoBounded(expected: 0, token: 88, bodyCaret: 0)
                let metadata = root.appendingPathComponent(
                    ".futo-editor-recovery", isDirectory: true)
                let prepared = try #require(
                    try FileManager.default.contentsOfDirectory(
                        at: metadata, includingPropertiesForKeys: nil
                    ).first { $0.pathExtension == "jsonl" })
                let owned = prepared.appendingPathExtension("owned")
                try FileManager.default.moveItem(at: prepared, to: owned)
                try Data("foreign".utf8).write(to: prepared)
                let before = try bounded.cursor()
                do {
                    _ = try bounded.intoFull()
                    Issue.record("foreign preparation cleanup accepted")
                } catch EditorBoundedError.Session(let error) {
                    guard case EditorSessionError.Recovery = error else { throw error }
                }
                #expect(try bounded.cursor() == before)
                #expect(try !bounded.resetRequired())
                // The rejected raw callback is retained by this caller. Copy
                // Draft continues to mean accepted exact Markdown only.
                let rejectedRaw: UInt32 = 120
                do {
                    _ = try bounded.insertLiteral(cursor: before, at: 1, scalar: rejectedRaw)
                    Issue.record("foreign preparation append accepted")
                } catch EditorBoundedError.Session(let error) {
                    guard case EditorSessionError.RecoveryAppend = error else { throw error }
                }
                let copy = try bounded.acceptedSource()
                #expect(try bounded.lastOperationWork().work.copiedBytes > 0)
                #expect(copy.source == source && copy.revision == 0 && copy.recovery.paused)
                #expect(try bounded.cursor() == before)
                do {
                    _ = try bounded.resumeRecovery()
                    Issue.record("foreign preparation resume accepted")
                } catch EditorBoundedError.Session(let error) {
                    guard case EditorSessionError.RecoveryResume = error else { throw error }
                }
                #expect(try Data(contentsOf: prepared) == Data("foreign".utf8))
                do {
                    _ = try store.openEditor(id: "plain")
                    Issue.record("failed transfer released the lease")
                } catch EditorSessionError.SessionAlreadyOpen {}
                try FileManager.default.removeItem(at: prepared)  // This test's foreign fixture.
                try FileManager.default.moveItem(at: owned, to: prepared)
                #expect(try !bounded.resumeRecovery().paused)
                _ = try bounded.insertLiteral(cursor: before, at: 1, scalar: rejectedRaw)
                let restored = try bounded.intoFull().session
                #expect(try restored.sourceText() == "```\naxb\n```\n")
                _ = try #require(try restored.undo(expected: 1))
                #expect(try restored.sourceText() == source)
                try restored.detach()
            }
        }.value
    }

    @Test("registry reset and terminal deletion preserve typed authority and accepted source")
    func resetAndDelete() async throws {
        try await Task.detached {
            try Self.vault { store, _ in
                _ = try store.createNote(title: "plain", folder: "", content: "```\nab\n```\n")
                let full = try store.openEditor(id: "plain")
                _ = try full.replaceUtf16(
                    expected: 0, range: EditorUtf16Range(start: 0, end: 0), inserted: [120])
                let bounded = try full.intoBounded(expected: 1, token: 89, bodyCaret: 0)
                let old = try bounded.cursor()
                _ = try store.rename(oldId: "plain", newId: "renamed")
                #expect(try bounded.resetRequired())
                do {
                    _ = try bounded.insertLiteral(cursor: old, at: 0, scalar: 65)
                    Issue.record("retired bounded coordinates accepted")
                } catch EditorBoundedError.ModeResetRequired {}
                let reset = try bounded.acceptedSource()
                #expect(reset.source == "```\nxab\n```\n" && reset.revision == 1)
                #expect(reset.resetRequired && !reset.deleted)
                let restored = try bounded.intoFull().session
                #expect(try restored.noteId() == "renamed")
                _ = try #require(try restored.undo(expected: 1))
                let deleted = try restored.intoBounded(expected: 2, token: 90, bodyCaret: 0)
                _ = try store.delete(id: "renamed")
                _ = try store.createNote(title: "renamed", folder: "", content: "fresh")
                do {
                    _ = try deleted.cursor()
                    Issue.record("deleted cursor accepted")
                } catch EditorBoundedError.Session(let error) {
                    guard case EditorSessionError.SessionDeleted = error else { throw error }
                }
                do {
                    _ = try deleted.intoFull()
                    Issue.record("deleted transfer accepted")
                } catch EditorBoundedError.Session(let error) {
                    guard case EditorSessionError.SessionDeleted = error else { throw error }
                }
                let copy = try deleted.acceptedSource()
                #expect(copy.deleted && copy.revision == 2 && copy.source == "```\nab\n```\n")
                try deleted.detach()
                let fresh = try store.openEditor(id: "renamed")
                #expect(try fresh.sourceText() == "fresh")
                try fresh.detach()
            }
        }.value
    }
}

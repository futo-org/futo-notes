import Foundation
import Testing

@testable import FutoNotesNative

/// Every later portable-session surface once through the real Store-backed session.
@Suite("Native editor complete contract surfaces")
struct NativeEditorContractSurfaceTests {
    private static func at(_ start: UInt64, _ end: UInt64) -> EditorByteRange {
        EditorByteRange(start: start, end: end)
    }

    /// Runs `body` on a fresh vault note; returns the source after a reopen;
    /// detach saves, so it must equal the stored bytes.
    private static func scenario(
        _ source: String, seed: (NoteStore) throws -> Void = { _ in },
        _ body: (NoteStore, NativeEditorSession) throws -> Void
    ) throws -> String {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "editor-surfaces-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = NoteStore(notesRoot: root.path)
        try seed(store)
        _ = try store.createNote(title: "n", folder: "", content: source)
        let session = try store.openEditor(id: "n")
        try body(store, session)
        _ = try session.detach()
        let reopened = try store.openEditor(id: "n")
        let reopenedSource = try reopened.sourceText()
        #expect(try store.read(id: "n") == reopenedSource)
        _ = try reopened.detach()
        return reopenedSource
    }

    @Test("tags, find and clipboard keep exact bytes")
    func tagsFindClipboard() async throws {
        try await Task.detached {
            let tagged = try Self.scenario("#a\n\nbody") { _, s in
                _ = try #require(try s.addHeaderTag(expected: 0, tag: "b"))
                #expect(try s.headerTags() == ["#a", "#b"])
                #expect(try s.tags() == ["#a", "#b"])
            }
            #expect(tagged == "#a #b\n\nbody")

            let front = "---\ntitle: x\n---\nbody"
            let framed = try Self.scenario(front) { _, s in
                let text = try s.displayText()
                let blocks = try s.project(
                    expected: 0, range: Self.at(0, UInt64(text.utf8.count))
                ).blocks
                #expect(blocks.filter(\.metadata).count == 1)
                #expect(blocks.last?.metadata == false)
            }
            #expect(framed == front)

            let found = try Self.scenario("a **bo**ld Bold\r\n\r\nBOLD") { _, s in
                let report = try s.findSetQuery(expected: 0, query: "bold")
                #expect((report.total, report.current) == (3, 1))
                #expect(report.reveal == Self.at(2, 6))
                #expect(try s.findStep(expected: 0, forward: true).current == 2)
                let early = try #require(try s.findScanRequest())
                _ = try s.replaceUtf16(
                    expected: 0, range: EditorUtf16Range(start: 0, end: 0),
                    inserted: Array("x ".utf16))
                #expect(try s.findReport().stale)
                #expect(try s.findApplyScan(result: editorFindScan(request: early)) == nil)
                let request = try #require(try s.findScanRequest())
                let rescanned = try #require(
                    try s.findApplyScan(result: editorFindScan(request: request)))
                #expect((rescanned.total, rescanned.stale) == (3, false))
                #expect(try s.findClose().open == false)
            }
            #expect(found == "x a **bo**ld Bold\r\n\r\nBOLD")

            let clipped = try Self.scenario("- ab **cd**") { _, s in
                #expect(try s.copyMarkdown(expected: 0, range: Self.at(4, 5)) == "**d**")
                _ = try #require(
                    try s.pasteMarkdown(expected: 0, range: Self.at(3, 3), text: "- x\n- y\n"))
                #expect(try s.sourceText() == "- ab \n- x\n- y\n- **cd**")
                let cut = try s.cutMarkdown(expected: 1, range: Self.at(8, 10))
                #expect(cut.markdown == "- **cd**")
                #expect(cut.change != nil)
            }
            #expect(clipped == "- ab \n- x\n- y\n- ")
        }.value
    }

    @Test("table cells, Tab and row insertion keep exact bytes")
    func tables() async throws {
        try await Task.detached {
            let grid = "| a | b |\r\n| --- | --: |\r\n| c | d |\r\n"
            let saved = try Self.scenario(grid) { _, s in
                let origin = try s.utf16ToDisplay(
                    expected: 0, range: EditorUtf16Range(start: 0, end: 0))
                let table = try #require(try s.inspectTable(expected: 0, range: origin))
                #expect((table.columns, table.rows.count) == (2, 2))
                let end = table.rows[0][0].content.end
                let caret = EditorUtf16Range(start: end, end: end)
                _ = try s.replaceUtf16(expected: 0, range: caret, inserted: [120, 124, 121])
                let moved = try #require(try s.tableKey(expected: 1, key: .tab))
                #expect(moved.selected?.revision == 1 && moved.edited == nil)
                _ = try #require(
                    try s.tableCommand(expected: 1, range: Self.at(2, 2), command: .insertRowBelow))
            }
            // A typed pipe is written as typed and adds a cell: the header row is three cells
            // wide, so the inserted row is too.
            #expect(saved == "| ax|y | b |\r\n| --- | --: |\r\n|  |  |  |\r\n| c | d |\r\n")
        }.value
    }

    @Test("note ids, wikilink completion and image atoms keep exact bytes")
    func linksAndImages() async throws {
        try await Task.detached {
            let seed: (NoteStore) throws -> Void = {
                _ = try $0.createNote(title: "Roadmap", folder: "Projects", content: "")
            }
            let roles = try Self.scenario("[[Roadmap]] ab", seed: seed) { store, s in
                let before = try s.project(expected: 0, range: Self.at(0, 11)).wikilinks[0]
                #expect((before.label, before.noteId) == ("Roadmap", "Projects/Roadmap"))
                _ = try store.createNote(title: "Roadmap", folder: "Archive", content: "")
                let change = try s.refreshNoteIds()
                #expect(change.revision == 0 && change.projections.count == 1)
                let after = try s.project(expected: 0, range: Self.at(0, 11)).wikilinks[0]
                #expect((after.label, after.noteId) == ("Roadmap", nil))
            }
            #expect(roles == "[[Roadmap]] ab")

            let completed = try Self.scenario("see [[Ro", seed: seed) { _, s in
                _ = try s.selectWithAffinity(expected: 0, range: Self.at(8, 8), affinity: .forward)
                let found = try #require(try s.wikilinkCompletion(expected: 0))
                #expect((found.range, found.query) == (Self.at(4, 8), "Ro"))
                #expect(found.candidates.map(\.noteId) == ["Projects/Roadmap"])
                do {
                    _ = try s.acceptWikilinkCompletion(
                        expected: 0, range: found.range, query: "R", noteId: "Projects/Roadmap")
                    Issue.record("stale claim accepted")
                } catch EditorSessionError.StaleClaim {}
                _ = try s.acceptWikilinkCompletion(
                    expected: 0, range: found.range, query: found.query, noteId: "Projects/Roadmap")
            }
            #expect(completed == "see [[Projects/Roadmap]]")

            let pictured = try Self.scenario("a ![x](image-1.png) b") { _, s in
                let atom = try #require(
                    try s.project(expected: 0, range: Self.at(0, 21)).atoms.first)
                #expect(atom.range == Self.at(2, 19) && atom.image?.destination == "image-1.png")
                let claim = try s.imageClaim()
                _ = try s.selectWithAffinity(
                    expected: 0, range: Self.at(21, 21), affinity: .forward)
                _ = try #require(
                    try s.insertImage(
                        expected: 0, claim: claim, reference: "image-2.png", alt: ""))
            }
            #expect(pictured == "a ![x](image-1.png) b![](image-2.png)")
        }.value
    }
}

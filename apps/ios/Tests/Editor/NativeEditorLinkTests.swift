import Foundation
import Testing

@testable import FutoNotesNative

@Suite("Native editor link contract")
struct NativeEditorLinkTests {
    @Test("link destinations survive native correction, URL commands, history and recovery")
    func linksRecoverExactly() async throws {
        try await Task.detached {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "editor-links-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(
                title: "links", folder: "", content: "[teh __😀 docs__](https://old.test 'Title')\r\n")
            let session = try store.openEditor(id: "links")
            var display = Array("teh 😀 docs\r\n".utf8)
            var revision: UInt64 = 0
            func apply(_ change: EditorViewChange) {
                #expect(change.previousRevision == revision)
                #expect(change.revision == revision + 1)
                display.replaceSubrange(
                    Int(change.range.start)..<Int(change.range.end), with: change.inserted.utf8)
                revision = change.revision
            }
            apply(try session.replaceUtf16(
                expected: 0, range: EditorUtf16Range(start: 0, end: 3), inserted: Array("the".utf16)))
            let link = try #require(try session.inspectLink(
                expected: 1, range: EditorByteRange(start: 1, end: 2)))
            #expect(link.destination == "https://old.test")
            #expect(link.range == EditorByteRange(start: 0, end: 13))
            #expect(try session.displayToUtf16(expected: 1, range: link.range)
                == EditorUtf16Range(start: 0, end: 11))
            apply(try #require(try session.setLink(
                expected: 1, range: EditorByteRange(start: 1, end: 2), destination: "https://x.test")))
            let updated = "[the __😀 docs__](https://x.test 'Title')\r\n"
            #expect(try session.sourceText() == updated)
            #expect(String(decoding: display, as: UTF8.self) == "the 😀 docs\r\n")
            apply(try #require(try session.undo(expected: 2)))
            #expect(try session.sourceText() == "[the __😀 docs__](https://old.test 'Title')\r\n")
            apply(try #require(try session.redo(expected: 3)))
            _ = try session.flushRecovery()
            try session.detach()
            let recovered = try store.openEditor(id: "links")
            #expect(try recovered.sourceText() == updated)
            #expect(try recovered.project(expected: 4, range: EditorByteRange(start: 0, end: 15))
                .links.first?.destination == "https://x.test")
            _ = try recovered.checkpoint()
            #expect(try store.read(id: "links") == updated)
            try recovered.detach()
        }.value
    }
}

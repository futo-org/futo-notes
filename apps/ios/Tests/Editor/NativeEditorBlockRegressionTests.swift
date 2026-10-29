import Foundation
import Testing

@testable import FutoNotesNative

@Suite("Native block regression contract")
struct NativeEditorBlockRegressionTests {
    @Test("block conversions preserve spaces, quote depth and physical setext prefixes")
    func blockRegressions() async throws {
        try await Task.detached {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "editor-block-regressions-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            let cases: [(String, EditorBlockCommand, String, String, UInt64)] = [
                ("   foo", .heading(level: 2), "## &#32;  foo", "   foo", 6),
                ("   # foo", .heading(level: 0), "foo", "foo", 0),
                ("> > ## 猫🦊 ##", .quote, "> > 猫🦊", "猫🦊", 0),
                (
                    "> foo\r\n> bar\r\n> ===", .heading(level: 0),
                    "> foo\r\n> bar", "foo\r\nbar", 5
                ),
            ]
            for (index, item) in cases.enumerated() {
                let (opening, command, expected, shown, caret) = item
                let id = "block-\(index)"
                _ = try store.createNote(title: id, folder: "", content: opening)
                let session = try store.openEditor(id: id)
                #expect(try session.displayText() == shown)
                let change = try #require(
                    try session.blockCommandUtf16(
                        expected: 0, range: EditorUtf16Range(start: caret, end: caret),
                        command: command))
                #expect(try session.sourceText() == expected)
                #expect(try session.displayText() == shown)
                #expect(change.selection.start == caret && change.selection.end == caret)
                _ = try session.undo(expected: 1)
                #expect(try session.sourceText() == opening)
                _ = try session.redo(expected: 2)
                _ = try session.flushRecovery()
                try session.detach()
                let recovered = try store.openEditor(id: id)
                #expect(try recovered.sourceText() == expected)
                #expect(try recovered.displayText() == shown)
                _ = try recovered.checkpoint()
                #expect(try store.read(id: id) == expected)
                try recovered.detach()
            }
        }.value
    }
}

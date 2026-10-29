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
    @Test("setext physical ownership and heading Enter preserve native ranges and recovery")
    func setextPhysicalOwnership() async throws {
        try await Task.detached {
            let cases: [(String, String, String, UInt64, UInt64, String, String, UInt64)] = [
                ("#x\n=", "#x", "text", 0, 2, "#x", "#x", 2),
                ("> x\n> y\n> =", "x\ny", "indent", 0, 3, "> > x\n> > y\n> > =", "x\ny", 3),
                (
                    "> > x\r\n> > y\r\n> > ---", "x\r\ny", "outdent", 0, 4,
                    "> x\r\n> y\r\n> ---", "x\r\ny", 4
                ),
                (
                    "> > 猫🦊\r\n> > e\u{301}\r\n> > ===", "猫🦊\r\ne\u{301}", "enter", 5, 5,
                    "> > 猫🦊\r\n> > ===\r\n\n> > e\u{301}", "猫🦊\r\n\ne\u{301}", 6
                ),
                ("> # x", "x", "enter", 0, 1, "> # \n> ", "\n", 1),
                ("> x\n> =", "x", "enter", 0, 1, "> # \n> ", "\n", 1),
                ("> x\n> =", "x", "delete", 0, 1, "> # ", "", 0),
            ]
            for (opening, shown, action, start, end, expected, display, caret) in cases {
                let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                    "editor-setext-\(UUID().uuidString)", isDirectory: true)
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: root) }
                let store = NoteStore(notesRoot: root.path)
                _ = try store.createNote(title: "setext", folder: "", content: opening)
                let session = try store.openEditor(id: "setext")
                #expect(try session.displayText() == shown)
                let selected = EditorUtf16Range(start: start, end: end)
                _ = try session.selectUtf16(expected: 0, range: selected)
                let change: EditorViewChange?
                switch action {
                case "enter":
                    change = try session.paragraphKeyUtf16(
                        expected: 0, range: selected, key: .enter)
                case "delete":
                    change = try session.replaceUtf16(expected: 0, range: selected, inserted: [])
                default:
                    let command: EditorBlockCommand =
                        action == "text"
                        ? .heading(level: 0)
                        : action == "indent" ? .indent : .outdent
                    change = try session.blockCommandUtf16(
                        expected: 0, range: selected, command: command)
                }
                let result = try #require(change)
                var view = Array(shown.utf8)
                view.replaceSubrange(
                    Int(result.range.start)..<Int(result.range.end), with: result.inserted.utf8)
                #expect(String(decoding: view, as: UTF8.self) == display)
                #expect(try session.sourceText() == expected)
                #expect(
                    try session.displayToUtf16(expected: 1, range: result.selection).end == caret)
                _ = try session.undo(expected: 1)
                #expect(try session.sourceText() == opening)
                _ = try session.redo(expected: 2)
                #expect(try session.sourceText() == expected)
                _ = try session.flushRecovery()
                try session.detach()
                let recovered = try store.openEditor(id: "setext")
                #expect(try recovered.sourceText() == expected)
                #expect(try recovered.displayText() == display)
                _ = try recovered.checkpoint()
                #expect(try store.read(id: "setext") == expected)
                try recovered.detach()
            }
        }.value
    }

}

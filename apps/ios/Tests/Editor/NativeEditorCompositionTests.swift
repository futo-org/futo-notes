import Foundation
import Testing

@testable import FutoNotesNative

@Suite("Native editor composition contract")
struct NativeEditorCompositionTests {
    @Test("marked Japanese, changed commit, OS correction and exact recovered bytes")
    func compositionAndCorrection() async throws {
        try await Task.detached {
            let root = FileManager.default.temporaryDirectory
                .appendingPathComponent(
                    "editor-composition-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(title: "input", folder: "", content: "__teh__ &amp; wrng\r\n")
            let session = try store.openEditor(id: "input")
            var view = Array("teh & wrng\r\n".utf8)
            func apply(_ change: EditorViewChange) {
                view.replaceSubrange(
                    Int(change.range.start)..<Int(change.range.end), with: change.inserted.utf8)
            }
            let marked = try session.composeUtf16(
                expected: 0, range: EditorUtf16Range(start: 0, end: 3), text: Array("にほん".utf16))
            #expect(marked.text == "にほん")
            #expect(try session.sourceText() == "__teh__ &amp; wrng\r\n")
            #expect(try session.undo(expected: 0) == nil)
            do {
                _ = try session.composeUtf16(
                    expected: 0, range: EditorUtf16Range(start: 0, end: 3), text: [0xD800])
                Issue.record("Malformed marked input was accepted")
            } catch EditorSessionError.InvalidText {}
            apply(
                try #require(
                    try session.commitCompositionUtf16(expected: 0, text: Array("the".utf16))))
            apply(
                try #require(
                    try session.replaceOsUtf16(
                        expected: 1, range: EditorUtf16Range(start: 0, end: 12),
                        text: Array("the & wrong\u{FFFC}\r\n".utf16),
                        placeholders: [EditorUtf16Range(start: 11, end: 12)])))
            #expect(String(decoding: view, as: UTF8.self) == "the & wrong\r\n")
            #expect(try session.sourceText() == "__the__ &amp; wrong\r\n")
            apply(try #require(try session.undo(expected: 2)))
            #expect(try session.sourceText() == "__the__ &amp; wrng\r\n")
            apply(try #require(try session.redo(expected: 3)))
            #expect(try session.flushRecovery().durable == 4)
            try session.detach()
            let recovered = try store.openEditor(id: "input")
            #expect(try recovered.sourceText() == "__the__ &amp; wrong\r\n")
            #expect(try recovered.composition() == nil)
            #expect(try recovered.commitCompositionUtf16(expected: 4, text: nil) == nil)
            try recovered.cancelComposition(expected: 4)
            try recovered.detach()
        }.value
    }
}

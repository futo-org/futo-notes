import Foundation
import Testing

@testable import FutoNotesNative

@Suite("Native editor composition contract")
struct NativeEditorCompositionTests {
    @Test("marked Japanese, changed commit, OS correction and exact saved bytes")
    func compositionAndCorrection() async throws {
        try await Task.detached {
            let root = FileManager.default.temporaryDirectory
                .appendingPathComponent(
                    "editor-composition-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            // `&amp;` is five literal characters: shown, corrected around and saved as typed.
            _ = try store.createNote(title: "input", folder: "", content: "__teh__ &amp; wrng\r\n")
            let session = try store.openEditor(id: "input")
            var view = Array("teh &amp; wrng\r\n".utf8)
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
            do {
                _ = try session.replaceUtf16Action(
                    expected: 0, range: EditorUtf16Range(start: 0, end: 1),
                    inserted: Array("the".utf16), action: .compositionCommit)
                Issue.record("Mixed composition ownership was accepted")
            } catch EditorSessionError.CompositionActive {}
            apply(
                try #require(
                    try session.commitCompositionUtf16(expected: 0, text: Array("the".utf16))))
            apply(
                try #require(
                    try session.replaceOsUtf16(
                        expected: 1, range: EditorUtf16Range(start: 0, end: 16),
                        text: Array("the &amp; wrong\u{FFFC}\r\n".utf16),
                        placeholders: [EditorUtf16Range(start: 15, end: 16)])))
            #expect(String(decoding: view, as: UTF8.self) == "the &amp; wrong\r\n")
            #expect(try session.sourceText() == "__the__ &amp; wrong\r\n")
            apply(try #require(try session.undo(expected: 2)))
            #expect(try session.sourceText() == "__the__ &amp; wrng\r\n")
            apply(try #require(try session.redo(expected: 3)))
            _ = try session.detach()
            let reopened = try store.openEditor(id: "input")
            #expect(try reopened.sourceText() == "__the__ &amp; wrong\r\n")
            #expect(try reopened.composition() == nil)
            #expect(try reopened.commitCompositionUtf16(expected: 0, text: nil) == nil)
            try reopened.cancelComposition(expected: 0)
            _ = try reopened.detach()
        }.value
    }
}

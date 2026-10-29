import Foundation
import Testing

@testable import FutoNotesNative

private struct StructuralSeamCase: Decodable {
    let name: String
    let source: String
    let display: String
    let mode: String
    let range: [UInt64]
    let text: String
    let expectedSource: String
    let expectedDisplay: String
    let caret: UInt64
    let history: Int
}
private final class StructuralSeamBundle {}

@Suite("Synthetic structural seam binding contract")
struct NativeEditorStructuralSeamTests {
    @Test("shared literal seams, raw marked text and OS runs recover with exact native carets")
    func structuralSeams() async throws {
        try await Task.detached {
            let url = try #require(
                Bundle(for: StructuralSeamBundle.self).url(
                    forResource: "structural-seams", withExtension: "json"))
            let cases = try JSONDecoder().decode(
                [StructuralSeamCase].self, from: Data(contentsOf: url))
            #expect(cases.count == 11)
            for item in cases {
                let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                    "editor-seams-\(UUID().uuidString)")
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: root) }
                let store = NoteStore(notesRoot: root.path)
                _ = try store.createNote(title: "seam", folder: "", content: item.source)
                let s = try store.openEditor(id: "seam")
                var view = Array(item.display.utf8)
                var last: EditorByteRange?
                func apply(_ change: EditorViewChange?) throws {
                    let change = try #require(change)
                    view.replaceSubrange(
                        Int(change.range.start)..<Int(change.range.end), with: change.inserted.utf8)
                    last = change.selection
                }
                let selected = EditorUtf16Range(start: item.range[0], end: item.range[1])
                if item.mode == "noop_indent" {
                    #expect(
                        try s.blockCommandUtf16(
                            expected: 0, range: EditorUtf16Range(start: 0, end: 0),
                            command: .heading(level: 1)) == nil)
                    #expect(try s.revision() == 0)
                    #expect(try s.sourceText() == item.source)
                }
                if ["indent", "noop_indent", "indent_os"].contains(item.mode) {
                    try apply(
                        s.blockCommandUtf16(
                            expected: s.revision(), range: EditorUtf16Range(start: 0, end: 0),
                            command: .indent))
                }
                switch item.mode {
                case "composition_commit":
                    for text in ["に", "日本"] {
                        let marked = try s.composeUtf16(
                            expected: 0, range: selected, text: Array(text.utf16))
                        #expect(marked.text == text)
                        #expect(try s.sourceText() == item.source)
                        #expect(try s.revision() == 0)
                    }
                    try s.cancelComposition(expected: 0)
                    #expect(try s.composition() == nil)
                    _ = try s.composeUtf16(
                        expected: 0, range: selected, text: Array(item.text.utf16))
                    try apply(s.commitCompositionUtf16(expected: 0, text: nil))
                case "composition_os":
                    _ = try s.composeUtf16(
                        expected: 0, range: EditorUtf16Range(start: 0, end: 0), text: [33])
                    try apply(
                        s.replaceOsUtf16(
                            expected: 0, range: selected, text: Array(item.text.utf16),
                            placeholders: []))
                    #expect(try s.revision() == 1)
                case "os", "indent_os":
                    try apply(
                        s.replaceOsUtf16(
                            expected: s.revision(), range: selected, text: Array(item.text.utf16),
                            placeholders: []))
                case "typing":
                    try apply(
                        s.replaceUtf16Action(
                            expected: 0, range: selected, inserted: Array(item.text.utf16),
                            action: .isolated))
                case "batch":
                    let runs: [(UInt64, UInt64, String)] = [(0, 1, "!"), (1, 2, "?"), (3, 5, "AC")]
                    try apply(
                        s.replaceManyUtf16(
                            expected: 0,
                            replacements: runs.map {
                                EditorUtf16Replacement(
                                    range: EditorUtf16Range(start: $0.0, end: $0.1),
                                    inserted: Array($0.2.utf16))
                            }))
                default: break
                }
                #expect(String(decoding: view, as: UTF8.self) == item.expectedDisplay)
                #expect(try s.sourceText() == item.expectedSource)
                let caret = try s.displayToUtf16(expected: s.revision(), range: #require(last))
                #expect(caret.start == item.caret && caret.end == item.caret)
                for _ in 0..<item.history { _ = try #require(try s.undo(expected: s.revision())) }
                #expect(try s.sourceText() == item.source)
                for _ in 0..<item.history { _ = try #require(try s.redo(expected: s.revision())) }
                #expect(try s.sourceText() == item.expectedSource)
                _ = try s.flushRecovery()
                try s.detach()
                let recovered = try store.openEditor(id: "seam")
                #expect(try recovered.sourceText() == item.expectedSource)
                #expect(try recovered.displayText() == item.expectedDisplay)
                _ = try recovered.checkpoint()
                #expect(try store.read(id: "seam") == item.expectedSource)
                try recovered.detach()
            }
        }.value
    }
}

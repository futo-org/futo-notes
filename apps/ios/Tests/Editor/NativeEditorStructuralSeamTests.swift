import Foundation
import Testing

@testable import FutoNotesNative

private struct StructuralSeamReplacement: Decodable {
    let start: UInt64
    let end: UInt64
    let text: String

    init(from decoder: Decoder) throws {
        var values = try decoder.unkeyedContainer()
        start = try values.decode(UInt64.self)
        end = try values.decode(UInt64.self)
        text = try values.decode(String.self)
    }
}
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
    let redoCaret: UInt64?
    let history: Int
    let replacements: [StructuralSeamReplacement]?
    let inputs: [[String]]?
    let format: String?
}
private final class StructuralSeamBundle {}

@Suite("Synthetic structural seam binding contract")
struct NativeEditorStructuralSeamTests {
    @Test("shared literal seams, raw marked text and OS runs recover with exact native carets")
    func structuralSeams() async throws {
        try await Task.detached {
            let cases = try ["structural-seams", "fence-physical-rows"].flatMap {
                name -> [StructuralSeamCase] in
                let url = try #require(
                    Bundle(for: StructuralSeamBundle.self).url(
                        forResource: name, withExtension: "json"))
                return try JSONDecoder().decode(
                    [StructuralSeamCase].self, from: Data(contentsOf: url))
            }
            #expect(cases.count == 72)
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
                case "composition_batch":
                    _ = try s.composeUtf16(
                        expected: 0, range: selected, text: Array(item.text.utf16))
                    #expect(try s.sourceText() == item.source)
                    try apply(
                        s.replaceManyUtf16(
                            expected: 0,
                            replacements: #require(item.replacements).map {
                                EditorUtf16Replacement(
                                    range: EditorUtf16Range(start: $0.start, end: $0.end),
                                    inserted: Array($0.text.utf16))
                            }))
                    #expect(try s.revision() == 1)
                case "composition_os", "distant_composition_os":
                    _ = try s.composeUtf16(
                        expected: 0,
                        range: EditorUtf16Range(
                            start: item.mode == "distant_composition_os" ? 17 : 0,
                            end: item.mode == "distant_composition_os" ? 17 : 0), text: [33])
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
                case "typing_sequence":
                    if let format = item.format {
                        let carried: EditorInlineFormat
                        switch format {
                        case "Bold": carried = .bold
                        case "Code": carried = .code
                        default: throw CocoaError(.coderInvalidValue)
                        }
                        #expect(try s.toggleFormat(expected: 0, format: carried) == nil)
                    }
                    var next = selected
                    for input in try #require(item.inputs) {
                        let action: EditorInputAction
                        switch input[0] {
                        case "Typing": action = .typing
                        case "Isolated": action = .isolated
                        default: throw CocoaError(.coderInvalidValue)
                        }
                        let change = try s.replaceUtf16Action(
                            expected: s.revision(), range: next, inserted: Array(input[1].utf16),
                            action: action)
                        next = try s.displayToUtf16(expected: s.revision(), range: change.selection)
                        try apply(change)
                    }
                case "typing":
                    try apply(
                        s.replaceUtf16Action(
                            expected: 0, range: selected, inserted: Array(item.text.utf16),
                            action: .isolated))
                case "explicit":
                    let runs =
                        item.replacements?.map {
                            EditorUtf16Replacement(
                                range: EditorUtf16Range(start: $0.start, end: $0.end),
                                inserted: Array($0.text.utf16))
                        } ?? [
                            EditorUtf16Replacement(
                                range: selected, inserted: Array(item.text.utf16))
                        ]
                    try apply(s.replaceManyUtf16(expected: 0, replacements: runs))
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
                var redone: EditorViewChange?
                for _ in 0..<item.history {
                    redone = try #require(try s.redo(expected: s.revision()))
                }
                #expect(try s.sourceText() == item.expectedSource)
                let redoneCaret = try s.displayToUtf16(
                    expected: s.revision(), range: #require(redone).selection)
                #expect(
                    redoneCaret.start == (item.redoCaret ?? item.caret)
                        && redoneCaret.end == redoneCaret.start)
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

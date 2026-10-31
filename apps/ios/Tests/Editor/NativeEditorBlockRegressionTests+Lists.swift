import Foundation
import Testing

@testable import FutoNotesNative

private struct ListItemExpectation: Decodable {
    let number: UInt64?
    let checked: Bool?
    init(from decoder: Decoder) throws {
        var values = try decoder.unkeyedContainer()
        number = try values.decodeIfPresent(UInt64.self)
        checked = try values.decodeIfPresent(Bool.self)
    }
}
private struct ListActionCase: Decodable {
    let name: String
    let source: String
    let display: String
    let action: String
    let range: [UInt64]
    let selection: [UInt64]?
    let composeRange: [UInt64]?
    let compositionText: String?
    let text: String?
    let expected: String
    let shown: String
    let resultRange: [UInt64]
    let undoSources: [String]?
    let undoDisplays: [String]?
    let undoRanges: [[UInt64]]?
    let finalItems: [ListItemExpectation]
    let quoteDepth: UInt64?
    let itemDepths: [UInt64]?
    let itemQuoteDepths: [UInt64]?
}
private final class ListActionBundle {}

extension NativeEditorBlockRegressionTests {
    @Test("shared list actions preserve native carets, metadata, history and recovery bytes")
    func listActions() async throws {
        try await Task.detached {
            func load(_ name: String) throws -> [ListActionCase] {
                let url = try #require(
                    Bundle(for: ListActionBundle.self).url(forResource: name, withExtension: "json")
                )
                return try JSONDecoder().decode([ListActionCase].self, from: Data(contentsOf: url))
            }
            let original = try load("list-actions")
            let shortcuts = try load("list-shortcuts")
            #expect(original.count == 24)
            #expect(shortcuts.count == 38)
            let staging = try load("list-staging")
            #expect(staging.count == 12)
            let nested = try load("nested-containers")
            #expect(nested.count == 35)
            let commands = try load("container-commands")
            #expect(commands.count == 27)
            let headers = try load("list-header-commands")
            #expect(headers.count == 14)
            let frames = try load("prefix-frame-commands")
            #expect(frames.count == 25)
            let fences = try load("fence-container-commands")
            #expect(fences.count == 14)
            let cases =
                original + shortcuts + staging + nested + commands + headers + frames + fences
            for item in cases {
                let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                    "editor-lists-\(UUID().uuidString)")
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: root) }
                let store = NoteStore(notesRoot: root.path)
                _ = try store.createNote(title: "lists", folder: "", content: item.source)
                let s = try store.openEditor(id: "lists")
                var view = Array(item.display.utf8)
                func native(_ values: [UInt64]) -> EditorUtf16Range {
                    EditorUtf16Range(start: values[0], end: values[1])
                }
                func apply(_ candidate: EditorViewChange?, _ expectedRange: [UInt64]?) throws {
                    let change = try #require(candidate)
                    view.replaceSubrange(
                        Int(change.range.start)..<Int(change.range.end), with: change.inserted.utf8)
                    if let expectedRange {
                        #expect(
                            try s.displayToUtf16(expected: change.revision, range: change.selection)
                                == native(expectedRange))
                    }
                }
                func checkItems(_ session: NativeEditorSession) throws {
                    let end = UInt64(item.shown.utf8.count)
                    var blocks = try session.project(
                        expected: session.revision(), range: EditorByteRange(start: 0, end: end)
                    ).blocks
                    for block in try session.project(
                        expected: session.revision(), range: EditorByteRange(start: end, end: end)
                    ).blocks {
                        if !blocks.contains(block) { blocks.append(block) }
                    }
                    let items = blocks.filter { $0.list?.first == true }
                    #expect(items.count == item.finalItems.count)
                    for (index, pair) in zip(items, item.finalItems).enumerated() {
                        let (block, expected) = pair
                        let list = try #require(block.list)
                        #expect(list.depth == (item.itemDepths?[index] ?? 1))
                        #expect(list.number == expected.number)
                        #expect(list.checked == expected.checked)
                        #expect(
                            block.quoteDepth
                                == (item.itemQuoteDepths?[index] ?? item.quoteDepth ?? 0))
                    }
                }
                #expect(try s.displayText() == item.display)
                let initial = item.selection ?? item.range
                _ = try s.selectUtf16(expected: 0, range: native(initial))
                if item.composeRange != nil {
                    _ = try s.composeUtf16(
                        expected: 0, range: native(#require(item.composeRange)),
                        text: Array(#require(item.compositionText ?? item.text).utf16))
                    #expect(try s.sourceText() == item.source)
                }
                let change: EditorViewChange?
                switch item.action {
                case "Typing":
                    change = try s.replaceUtf16Action(
                        expected: 0, range: native(item.range),
                        inserted: Array(#require(item.text).utf16), action: .typing)
                case "Enter", "Backspace", "Delete":
                    change = try s.paragraphKeyUtf16(
                        expected: 0, range: native(item.range),
                        key: item.action == "Enter"
                            ? .enter : item.action == "Delete" ? .delete : .backspace)
                default:
                    let command: EditorBlockCommand
                    switch item.action {
                    case "Text": command = .heading(level: 0)
                    case "Heading2": command = .heading(level: 2)
                    case "Indent": command = .indent
                    case "Outdent": command = .outdent
                    case "BulletList": command = .bulletList
                    case "OrderedList": command = .orderedList
                    case "TaskList": command = .taskList
                    case "ToggleTask", "ComposeToggleTask": command = .toggleTask
                    default: throw NSError(domain: "UnknownListAction", code: 1)
                    }
                    change = try s.blockCommandUtf16(
                        expected: 0, range: native(item.range), command: command)
                }
                try apply(change, item.resultRange)
                #expect(try s.revision() == 1)
                #expect(try s.sourceText() == item.expected)
                #expect(String(decoding: view, as: UTF8.self) == item.shown)
                try checkItems(s)
                let history = item.undoSources?.count ?? 1
                for step in 0..<history {
                    try apply(s.undo(expected: s.revision()), item.undoRanges?[step] ?? initial)
                    #expect(try s.sourceText() == (item.undoSources?[step] ?? item.source))
                    #expect(
                        String(decoding: view, as: UTF8.self)
                            == (item.undoDisplays?[step] ?? item.display))
                }
                #expect(try s.undo(expected: s.revision()) == nil)
                for step in 0..<history {
                    try apply(
                        s.redo(expected: s.revision()), step == history - 1 ? item.resultRange : nil
                    )
                }
                #expect(try s.sourceText() == item.expected)
                #expect(String(decoding: view, as: UTF8.self) == item.shown)
                _ = try s.flushRecovery()
                try s.detach()
                let recovered = try store.openEditor(id: "lists")
                #expect(try recovered.sourceText() == item.expected)
                #expect(try recovered.displayText() == item.shown)
                try checkItems(recovered)
                #expect(try recovered.undo(expected: recovered.revision()) == nil)
                _ = try recovered.checkpoint()
                #expect(try store.read(id: "lists") == item.expected)
                try recovered.detach()
                let reopened = try store.openEditor(id: "lists")
                #expect(try reopened.sourceText() == item.expected)
                try reopened.detach()
            }
        }.value
    }
}

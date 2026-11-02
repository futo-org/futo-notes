import Foundation
import Testing

@testable import FutoNotesNative

private struct InputTraceCase: Decodable {
    let name: String
    let source: String
    let display: String
    let range: [UInt64]
    let steps: [Step]
    let history: [History]
    struct History: Decodable {
        let source: String
        let display: String
        let selection: [UInt64]
        let undoSelection: [UInt64]?
    }
    struct Step: Decodable {
        let event: Int
        let operation: String
        let source: String
        let serviceRange: [UInt64]?
        let serviceText: String?
        let parentMethod: String?
        let requestEvent: Int?
    }
}

private struct InputTrace: Decodable {
    var events: [Event] = []
    let eventFiles: [String]
    let current: Snapshot
    enum CodingKeys: String, CodingKey { case eventFiles, current }
    struct Snapshot: Decodable {
        let textUTF16: [UInt16]
        let selected: [UInt64]
        let marked: [Int]?
        var text: String { String(decoding: textUTF16, as: UTF16.self) }
    }
    struct Event: Decodable {
        let id: Int
        let parent: Int?
        let method: String
        let after: Snapshot
        let before: Snapshot
        let arguments: Arguments
        struct Arguments: Decodable {
            let textUTF16: [UInt16]?
            let range: [UInt64]?
        }
    }
}

private func inputFixture<T: Decodable>(_ name: String, _ type: T.Type) throws -> T {
    let url = try #require(
        Bundle(for: NativeInputTraceBundle.self).url(forResource: name, withExtension: "json"))
    return try JSONDecoder().decode(type, from: Data(contentsOf: url))
}
private final class NativeInputTraceBundle {}

@Suite("Captured native editor input")
struct NativeEditorInputTraceTests {
    @Test("actual delegate snapshots retain exact source, history and saved bytes")
    func capturedOSResults() async throws {
        try await Task.detached {
            let fixtures = try inputFixture("native-input-cases", [InputTraceCase].self)
            #expect(fixtures.count == 6)
            for fixture in fixtures {
                var trace = try inputFixture(fixture.name, InputTrace.self)
                for file in trace.eventFiles {
                    trace.events += try inputFixture(file, [InputTrace.Event].self)
                }
                let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                    "native-trace-\(UUID().uuidString)")
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: root) }
                let store = NoteStore(notesRoot: root.path)
                _ = try store.createNote(title: "input", folder: "", content: fixture.source)
                let editor = try store.openEditor(id: "input")
                var view = Array(fixture.display.utf8)
                var revision: UInt64 = 0
                var lastSelection: EditorUtf16Range?
                func apply(_ change: EditorViewChange) throws {
                    #expect(change.previousRevision == revision)
                    #expect(change.revision == revision + 1)
                    view.replaceSubrange(
                        Int(change.range.start)..<Int(change.range.end), with: change.inserted.utf8)
                    revision = change.revision
                    lastSelection = try editor.displayToUtf16(
                        expected: revision, range: change.selection)
                }
                for step in fixture.steps {
                    let event = try #require(trace.events.first { $0.id == step.event })
                    let native = event.after
                    var change: EditorViewChange?
                    switch step.operation {
                    case "select":
                        #expect(event.method == "didChangeSelection")
                        _ = try editor.selectUtf16(
                            expected: revision,
                            range: EditorUtf16Range(
                                start: native.selected[0], end: native.selected[1]))
                    case "marked":
                        #expect(event.method == "didChange")
                        #expect(event.parent == nil)
                        let marked = try #require(native.marked)
                        let overlay = try editor.composeUtf16(
                            expected: revision,
                            range: EditorUtf16Range(start: fixture.range[0], end: fixture.range[1]),
                            text: Array(native.textUTF16[marked[0]..<marked[1]]))
                        var provisional = view
                        provisional.replaceSubrange(
                            Int(overlay.range.start)..<Int(overlay.range.end),
                            with: overlay.text.utf8)
                        #expect(String(decoding: provisional, as: UTF8.self) == native.text)
                        #expect(try editor.saveStatus().revision == revision)
                    case "typing":
                        let parent = try #require(trace.events.first { $0.id == event.parent })
                        #expect(parent.method == "insertText")
                        #expect(parent.before.text == String(decoding: view, as: UTF8.self))
                        change = try editor.replaceUtf16(
                            expected: revision,
                            range: EditorUtf16Range(
                                start: parent.before.selected[0], end: parent.before.selected[1]),
                            inserted: try #require(parent.arguments.textUTF16))
                    case "commit":
                        let parent = try #require(trace.events.first { $0.id == event.parent })
                        #expect(parent.method == "unmarkText")
                        change = try editor.commitCompositionUtf16(expected: revision, text: nil)
                    case "replace":
                        if let parentID = event.parent {
                            let parent = try #require(trace.events.first { $0.id == parentID })
                            #expect(parent.method == (step.parentMethod ?? "insertText"))
                        } else {
                            let request = try #require(
                                trace.events.first { $0.id == (step.requestEvent ?? event.id - 1) })
                            #expect(request.method == "shouldChangeText")
                            #expect(request.arguments.range == step.serviceRange)
                            #expect(
                                request.arguments.textUTF16
                                    == step.serviceText.map { Array($0.utf16) })
                            #expect(request.before.text == String(decoding: view, as: UTF8.self))
                        }
                        let footprint = try #require(step.serviceRange)
                        let replacement = try #require(step.serviceText)
                        change = try editor.replaceOsUtf16(
                            expected: revision,
                            range: EditorUtf16Range(start: footprint[0], end: footprint[1]),
                            text: Array(replacement.utf16), placeholders: [])
                    default: Issue.record("Unknown native replay operation")
                    }
                    if let change {
                        try apply(change)
                        #expect(lastSelection?.start == native.selected[0])
                        #expect(lastSelection?.end == native.selected[1])
                        #expect(String(decoding: view, as: UTF8.self) == native.text)
                    }
                    #expect(try editor.sourceText() == step.source)
                }
                #expect(String(decoding: view, as: UTF8.self) == trace.current.text)
                #expect(try editor.commitCompositionUtf16(expected: revision, text: nil) == nil)
                for expected in fixture.history.dropLast().reversed() {
                    try apply(try #require(try editor.undo(expected: revision)))
                    #expect(
                        lastSelection?.start == (expected.undoSelection ?? expected.selection)[0])
                    #expect(lastSelection?.end == (expected.undoSelection ?? expected.selection)[1])
                    #expect(try editor.sourceText() == expected.source)
                    #expect(String(decoding: view, as: UTF8.self) == expected.display)
                }
                for expected in fixture.history.dropFirst() {
                    try apply(try #require(try editor.redo(expected: revision)))
                    #expect(lastSelection?.start == expected.selection[0])
                    #expect(lastSelection?.end == expected.selection[1])
                    #expect(try editor.sourceText() == expected.source)
                    #expect(String(decoding: view, as: UTF8.self) == expected.display)
                }
                _ = try editor.detach()
                let reopened = try store.openEditor(id: "input")
                #expect(try reopened.sourceText() == fixture.steps.last?.source)
                _ = try reopened.detach()
            }
        }.value
    }
}

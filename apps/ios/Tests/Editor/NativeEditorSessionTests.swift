import Foundation
import Testing

@testable import FutoNotesNative

@Suite("Native editor session contract")
struct NativeEditorSessionTests {
    @Test("exact Unicode input, structured errors, deltas, history and recovery")
    func nativeSessionRoundTrip() async throws {
        try await Task.detached {
            let root = FileManager.default.temporaryDirectory
                .appendingPathComponent("editor-native-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(title: "plain", folder: "", content: "a😀\0z\r\n")
            let session = try store.openEditor(id: "plain")
            #expect(try session.sourceText() == "a😀\0z\r\n")
            let selected = try session.selectUtf16(expected: 0, range: EditorUtf16Range(start: 1, end: 3))
            #expect(selected.selection == EditorByteRange(start: 1, end: 5))
            #expect(try session.displayToUtf16(expected: 0, range: selected.selection) == EditorUtf16Range(start: 1, end: 3))
            do {
                _ = try session.replaceUtf16(expected: 0, range: EditorUtf16Range(start: 1, end: 3), inserted: [0xD800])
                Issue.record("Malformed input was accepted")
            } catch EditorSessionError.InvalidText {}
            do {
                _ = try session.replaceUtf16(expected: 0, range: EditorUtf16Range(start: 2, end: 3), inserted: [65])
                Issue.record("A split surrogate range was accepted")
            } catch EditorSessionError.InvalidRange {}
            let change = try session.replaceUtf16(expected: 0, range: EditorUtf16Range(start: 1, end: 3), inserted: Array("🇯🇵\0".utf16))
            #expect(change.previousRevision == 0)
            #expect(change.revision == 1)
            #expect(change.range == EditorByteRange(start: 1, end: 5))
            #expect(change.inserted == "🇯🇵\0")
            #expect(change.selection == EditorByteRange(start: 10, end: 10))
            var view = Array("a😀\0z\r\n".utf8)
            view.replaceSubrange(Int(change.range.start)..<Int(change.range.end), with: change.inserted.utf8)
            #expect(String(decoding: view, as: UTF8.self) == "a🇯🇵\0\0z\r\n")
            #expect(try session.sourceText() == "a🇯🇵\0\0z\r\n")
            do {
                _ = try session.replaceUtf16(expected: 0, range: EditorUtf16Range(start: 0, end: 0), inserted: [65])
                Issue.record("Stale input was accepted")
            } catch EditorSessionError.StaleRevision(let expected, let actual) {
                #expect(expected == 0 && actual == 1)
            }
            _ = try session.undo(expected: 1)
            #expect(try session.sourceText() == "a😀\0z\r\n")
            _ = try session.redo(expected: 2)
            #expect(try session.flushRecovery().durable == 3)
            try session.detach()
            let recovered = try store.openEditor(id: "plain")
            #expect(try recovered.sourceText() == "a🇯🇵\0\0z\r\n")
            #expect(try recovered.revision() == 3)
            let result = try recovered.checkpoint()
            #expect(result.mutation?.finalId == "plain")
            #expect(try store.read(id: "plain") == "a🇯🇵\0\0z\r\n")
            try recovered.detach()
            _ = try store.createNote(title: "inline", folder: "", content: "__日😀__ tail\r\n")
            let inline = try store.openEditor(id: "inline")
            let projection = try inline.project(expected: 0, range: EditorByteRange(start: 0, end: 14))
            #expect(projection.text == "日😀 tail\r\n")
            #expect(projection.runs.first?.formats == [.bold])
            try inline.detach()
            _ = try store.createNote(title: "entity", folder: "", content: "&acE;")
            let entity = try store.openEditor(id: "entity")
            #expect(try entity.displayText() == "∾\u{0333}")
            #expect(try entity.sourceAt(expected: 0, offset: EditorDisplayByteOffset(offset: 3), affinity: .backward).offset == 0)
            #expect(try entity.sourceAt(expected: 0, offset: EditorDisplayByteOffset(offset: 3), affinity: .forward).offset == 5)
            try entity.detach()

        }.value
    }
}

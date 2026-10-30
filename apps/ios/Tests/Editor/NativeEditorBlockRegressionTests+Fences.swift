import Foundation
import Testing

@testable import FutoNotesNative

extension NativeEditorBlockRegressionTests {
    @Test("fences expose language and recover exact opaque Unicode contents")
    func fencedCode() async throws {
        try await Task.detached {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "editor-fences-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            let opening = "~~~~ c++ info\r\n猫🦊\r\n~~~~~  \r\n\n__tail__"
            let expected = "~~~~ c++ info\r\n猫\n🦊\r\n~~~~~  \r\n\n__tail__"
            _ = try store.createNote(title: "code", folder: "", content: opening)
            let session = try store.openEditor(id: "code")
            #expect(try session.displayText() == "猫🦊\r\n\ntail")
            let change = try session.paragraphKeyUtf16(
                expected: 0, range: EditorUtf16Range(start: 1, end: 1), key: .enter)
            #expect(change?.projection.blocks.first(where: { $0.code })?.language == "c++")
            #expect(try session.sourceText() == expected)
            #expect(try session.displayText() == "猫\n🦊\r\n\ntail")
            _ = try session.undo(expected: 1)
            #expect(try session.sourceText() == opening)
            _ = try session.redo(expected: 2)
            _ = try session.flushRecovery()
            try session.detach()
            let recovered = try store.openEditor(id: "code")
            #expect(try recovered.sourceText() == expected)
            _ = try recovered.checkpoint()
            #expect(try store.read(id: "code") == expected)
            try recovered.detach()
            _ = try store.createNote(title: "tabs", folder: "", content: "~~~js\nab\n cd\n~~~")
            let tabs = try store.openEditor(id: "tabs")
            _ = try tabs.paragraphKeyUtf16(
                expected: 0, range: EditorUtf16Range(start: 1, end: 1), key: .tab)
            #expect(try tabs.sourceText() == "~~~js\na  b\n cd\n~~~")
            _ = try tabs.paragraphKeyUtf16(
                expected: 1, range: EditorUtf16Range(start: 6, end: 6), key: .shiftTab)
            #expect(try tabs.sourceText() == "~~~js\na  b\ncd\n~~~")
            try tabs.detach()
            _ = try store.createNote(title: "command", folder: "", content: "ab")
            let command = try store.openEditor(id: "command")
            _ = try command.blockCommandUtf16(
                expected: 0, range: EditorUtf16Range(start: 0, end: 0), command: .codeBlock)
            #expect(try command.sourceText() == "```\nab\n```")
            try command.detach()
        }.value
    }

}

import Foundation
import Testing

@testable import FutoNotesNative

@Suite("Native editor session contract")
struct NativeEditorSessionTests {
    @Test("identity changes deliver ordered relinks and delete fences old capabilities")
    func identityChanges() async throws {
        try await Task.detached {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "editor-identity-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(title: "old", folder: "", content: "[[old]]")
            let session = try store.openEditor(id: "old")
            var view = Array("[[old]]".utf8)
            var revision: UInt64 = 0
            func apply(_ change: EditorViewChange) {
                #expect(change.previousRevision == revision)
                #expect(change.revision == revision + 1)
                view.replaceSubrange(
                    Int(change.range.start)..<Int(change.range.end), with: change.inserted.utf8)
                revision = change.revision
            }
            apply(
                try session.replaceUtf16(
                    expected: 0, range: EditorUtf16Range(start: 7, end: 7), inserted: [33]))
            _ = try session.checkpoint()
            _ = try store.rename(oldId: "old", newId: "long name")
            #expect(try session.noteId() == "long name")
            let changes = try session.takeCoordinatedChanges()
            #expect(changes.count == 1)
            for change in changes { apply(change) }
            #expect(try session.takeCoordinatedChanges().isEmpty)
            #expect(String(decoding: view, as: UTF8.self) == "[[long name]]!")
            // A relink is one ordinary Undo step: Undo restores the old link
            // text, then the earlier typed "!" undoes as usual.
            apply(try #require(try session.undo(expected: revision)))
            #expect(String(decoding: view, as: UTF8.self) == "[[old]]!")
            apply(try #require(try session.undo(expected: revision)))
            #expect(String(decoding: view, as: UTF8.self) == "[[old]]")
            _ = try store.delete(id: "long name")
            _ = try store.createNote(title: "long name", folder: "", content: "fresh")
            do {
                _ = try session.checkpoint()
                Issue.record("deleted session checkpoint accepted")
            } catch EditorSessionError.SessionDeleted {}
            _ = try session.detach()
            let fresh = try store.openEditor(id: "long name")
            #expect(try fresh.sourceText() == "fresh")
            _ = try fresh.detach()
        }.value
    }

    @Test("paragraph keys preserve platform ranges, exact line endings and save")
    func paragraphKeys() async throws {
        try await Task.detached {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "editor-lines-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(title: "lines", folder: "", content: "__a😀b__\r\ntail  \r\n")
            let session = try store.openEditor(id: "lines")
            _ = try session.selectUtf16(expected: 0, range: EditorUtf16Range(start: 8, end: 8))
            var view = Array("a😀b\r\ntail  \r\n".utf8)
            func apply(_ change: EditorViewChange?) {
                guard let change else {
                    Issue.record("missing paragraph change")
                    return
                }
                view.replaceSubrange(
                    Int(change.range.start)..<Int(change.range.end), with: change.inserted.utf8)
            }
            apply(
                try session.paragraphKeyUtf16(
                    expected: 0, range: EditorUtf16Range(start: 3, end: 3), key: .shiftEnter))
            #expect(String(decoding: view, as: UTF8.self) == "a😀\nb\r\ntail  \r\n")
            #expect(try session.sourceText() == "__a😀\nb__\r\ntail  \r\n")
            apply(
                try session.paragraphKeyUtf16(
                    expected: 1, range: EditorUtf16Range(start: 4, end: 4), key: .backspace))
            #expect(String(decoding: view, as: UTF8.self) == "a😀b\r\ntail  \r\n")
            apply(try session.undo(expected: 2))
            #expect(try session.sourceText() == "__a😀\nb__\r\ntail  \r\n")
            _ = try session.detach()
            #expect(try store.read(id: "lines") == "__a😀\nb__\r\ntail  \r\n")
            let reopened = try store.openEditor(id: "lines")
            #expect(try reopened.sourceText() == "__a😀\nb__\r\ntail  \r\n")
            _ = try reopened.detach()
        }.value
    }

    @Test("exact Unicode input, structured errors, deltas, history and save")
    func nativeSessionRoundTrip() async throws {
        try await Task.detached {
            let root = FileManager.default.temporaryDirectory
                .appendingPathComponent("editor-native-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(title: "plain", folder: "", content: "a😀\0z\r\n")
            let session = try store.openEditor(id: "plain")
            #expect(try session.saveDelay() == nil)
            #expect(try session.sourceText() == "a😀\0z\r\n")
            let selected = try session.selectUtf16(
                expected: 0, range: EditorUtf16Range(start: 1, end: 3))
            #expect(selected.selection == EditorByteRange(start: 1, end: 5))
            #expect(
                try session.displayToUtf16(expected: 0, range: selected.selection)
                    == EditorUtf16Range(start: 1, end: 3))
            do {
                _ = try session.replaceUtf16(
                    expected: 0, range: EditorUtf16Range(start: 1, end: 3), inserted: [0xD800])
                Issue.record("Malformed input was accepted")
            } catch EditorSessionError.InvalidText {}
            do {
                _ = try session.replaceUtf16(
                    expected: 0, range: EditorUtf16Range(start: 2, end: 3), inserted: [65])
                Issue.record("A split surrogate range was accepted")
            } catch EditorSessionError.InvalidRange {}
            let change = try session.replaceUtf16(
                expected: 0, range: EditorUtf16Range(start: 1, end: 3), inserted: Array("🇯🇵\0".utf16)
            )
            let delay = try #require(try session.saveDelay())
            #expect(delay >= 0 && delay <= 0.5)
            #expect(change.previousRevision == 0)
            #expect(change.revision == 1)
            #expect(change.range == EditorByteRange(start: 1, end: 5))
            #expect(change.inserted == "🇯🇵\0")
            #expect(change.selection == EditorByteRange(start: 10, end: 10))
            var view = Array("a😀\0z\r\n".utf8)
            view.replaceSubrange(
                Int(change.range.start)..<Int(change.range.end), with: change.inserted.utf8)
            #expect(String(decoding: view, as: UTF8.self) == "a🇯🇵\0\0z\r\n")
            #expect(try session.sourceText() == "a🇯🇵\0\0z\r\n")
            do {
                _ = try session.replaceUtf16(
                    expected: 0, range: EditorUtf16Range(start: 0, end: 0), inserted: [65])
                Issue.record("Stale input was accepted")
            } catch EditorSessionError.StaleRevision(let expected, let actual) {
                #expect(expected == 0 && actual == 1)
            }
            _ = try session.undo(expected: 1)
            #expect(try session.sourceText() == "a😀\0z\r\n")
            _ = try session.redo(expected: 2)
            #expect(try session.saveStatus().revision == 3)
            #expect(try session.saveStatus().saved == 0)
            let result = try session.detach()
            #expect(result.mutation?.finalId == "plain")
            #expect(try store.read(id: "plain") == "a🇯🇵\0\0z\r\n")
            let reopened = try store.openEditor(id: "plain")
            #expect(try reopened.sourceText() == "a🇯🇵\0\0z\r\n")
            #expect(try reopened.saveDelay() == nil)
            _ = try reopened.detach()
            _ = try store.createNote(title: "inline", folder: "", content: "__日😀__ tail\r\n")
            let inline = try store.openEditor(id: "inline")
            let projection = try inline.project(
                expected: 0, range: EditorByteRange(start: 0, end: 14))
            #expect(projection.text == "日😀 tail\r\n")
            #expect(projection.runs.first?.formats == [.bold])
            _ = try inline.detach()
            _ = try store.createNote(title: "entity", folder: "", content: "&acE;")
            let entity = try store.openEditor(id: "entity")
            #expect(try entity.displayText() == "∾\u{0333}")
            #expect(
                try entity.sourceAt(
                    expected: 0, offset: EditorDisplayByteOffset(offset: 3), affinity: .backward
                ).offset == 0)
            #expect(
                try entity.sourceAt(
                    expected: 0, offset: EditorDisplayByteOffset(offset: 3), affinity: .forward
                ).offset == 5)
            _ = try entity.detach()

        }.value
    }
    @Test("isolated commits and compound replacements preserve exact history")
    func exactGroupedHistory() async throws {
        try await Task.detached {
            let root = FileManager.default.temporaryDirectory
                .appendingPathComponent("editor-history-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            let opening = "__cat__ &amp; _dog_\r\n"
            _ = try store.createNote(title: "history", folder: "", content: opening)
            let session = try store.openEditor(id: "history")
            var view = Array("cat & dog\r\n".utf8)
            var revision: UInt64 = 0
            func apply(_ change: EditorViewChange) {
                #expect(change.previousRevision == revision)
                #expect(change.revision == revision + 1)
                view.replaceSubrange(
                    Int(change.range.start)..<Int(change.range.end), with: change.inserted.utf8)
                revision = change.revision
            }
            _ = try session.selectWithAffinity(
                expected: 0, range: EditorByteRange(start: 0, end: 3), affinity: .forward)
            apply(try #require(try session.toggleFormat(expected: 0, format: .italic)))
            #expect(try session.sourceText() == "*__cat__* &amp; _dog_\r\n")
            apply(
                try session.replaceManyUtf16(
                    expected: 1,
                    replacements: [
                        EditorUtf16Replacement(
                            range: EditorUtf16Range(start: 0, end: 3),
                            inserted: Array("kitten".utf16)),
                        EditorUtf16Replacement(
                            range: EditorUtf16Range(start: 6, end: 9), inserted: Array("ox".utf16)),
                    ]))
            #expect(try session.sourceText() == "*__kitten__* &amp; _ox_\r\n")
            apply(
                try session.replaceUtf16Action(
                    expected: 2, range: EditorUtf16Range(start: 11, end: 11),
                    inserted: Array("日本".utf16), action: .compositionCommit))
            #expect(try session.sourceText() == "*__kitten__* &amp; _ox日本_\r\n")
            apply(
                try session.replaceUtf16Action(
                    expected: 3, range: EditorUtf16Range(start: 13, end: 13),
                    inserted: [33], action: .isolated))
            let final = "*__kitten__* &amp; _ox日本!_\r\n"
            #expect(try session.sourceText() == final)
            #expect(String(decoding: view, as: UTF8.self) == "kitten & ox日本!\r\n")
            for expected in [
                "*__kitten__* &amp; _ox日本_\r\n", "*__kitten__* &amp; _ox_\r\n",
                "*__cat__* &amp; _dog_\r\n", opening,
            ] {
                let change = try #require(try session.undo(expected: revision))
                apply(change)
                #expect(try session.sourceText() == expected)
            }
            #expect(String(decoding: view, as: UTF8.self) == "cat & dog\r\n")
            #expect(try session.undo(expected: 8) == nil)
            for expected in [
                "*__cat__* &amp; _dog_\r\n", "*__kitten__* &amp; _ox_\r\n",
                "*__kitten__* &amp; _ox日本_\r\n", final,
            ] {
                apply(try #require(try session.redo(expected: revision)))
                #expect(try session.sourceText() == expected)
            }
            #expect(try session.activeFormats() == [.italic])
            do {
                _ = try session.replaceManyUtf16(
                    expected: 12,
                    replacements: [
                        EditorUtf16Replacement(
                            range: EditorUtf16Range(start: 0, end: 6), inserted: [97]),
                        EditorUtf16Replacement(
                            range: EditorUtf16Range(start: 9, end: 11), inserted: [0xD800]),
                    ])
                Issue.record("A malformed later run was accepted")
            } catch EditorSessionError.InvalidText {}
            #expect(try session.sourceText() == final)
            #expect(try session.revision() == 12)
            #expect(try session.detach().mutation?.finalId == "history")
            #expect(try store.read(id: "history") == final)
            let reopened = try store.openEditor(id: "history")
            #expect(try reopened.sourceText() == final)
            #expect(try reopened.undo(expected: 0) == nil)
            _ = try reopened.detach()
            _ = try store.createNote(title: "echo", folder: "", content: "__a__")
            let echo = try store.openEditor(id: "echo")
            _ = try echo.selectWithAffinity(
                expected: 0, range: EditorByteRange(start: 1, end: 1), affinity: .backward)
            _ = try echo.replaceUtf16(
                expected: 0, range: EditorUtf16Range(start: 1, end: 1), inserted: [32])
            _ = try echo.selectWithAffinity(
                expected: 1, range: EditorByteRange(start: 2, end: 2), affinity: .backward)
            _ = try echo.replaceUtf16Action(
                expected: 1, range: EditorUtf16Range(start: 2, end: 2), inserted: [98],
                action: .typing)
            #expect(try echo.sourceText() == "__a b__")
            #expect(try echo.activeFormats() == [.bold])
            _ = try echo.detach()

        }.value
    }

}

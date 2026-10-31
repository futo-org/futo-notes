import Foundation
import Testing

@testable import FutoNotesNative

@Suite("Native editor link contract")
struct NativeEditorLinkTests {
    @Test("link destinations survive native correction, URL commands, history and recovery")
    func linksRecoverExactly() async throws {
        try await Task.detached {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "editor-links-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(
                title: "links", folder: "",
                content: "[teh __😀 docs__](https://old.test 'Title')\r\n")
            let session = try store.openEditor(id: "links")
            var display = Array("teh 😀 docs\r\n".utf8)
            var revision: UInt64 = 0
            func apply(_ change: EditorViewChange) {
                #expect(change.previousRevision == revision)
                #expect(change.revision == revision + 1)
                display.replaceSubrange(
                    Int(change.range.start)..<Int(change.range.end), with: change.inserted.utf8)
                revision = change.revision
            }
            apply(
                try session.replaceUtf16(
                    expected: 0, range: EditorUtf16Range(start: 0, end: 3),
                    inserted: Array("the".utf16)))
            let link = try #require(
                try session.inspectLink(
                    expected: 1, range: EditorByteRange(start: 1, end: 2)))
            #expect(link.destination == "https://old.test")
            #expect(link.range == EditorByteRange(start: 0, end: 13))
            #expect(
                try session.displayToUtf16(expected: 1, range: link.range)
                    == EditorUtf16Range(start: 0, end: 11))
            apply(
                try #require(
                    try session.setLink(
                        expected: 1, range: EditorByteRange(start: 1, end: 2),
                        destination: "https://x.test")))
            let updated = "[the __😀 docs__](https://x.test 'Title')\r\n"
            #expect(try session.sourceText() == updated)
            #expect(String(decoding: display, as: UTF8.self) == "the 😀 docs\r\n")
            apply(try #require(try session.undo(expected: 2)))
            #expect(try session.sourceText() == "[the __😀 docs__](https://old.test 'Title')\r\n")
            apply(try #require(try session.redo(expected: 3)))
            _ = try session.flushRecovery()
            try session.detach()
            let recovered = try store.openEditor(id: "links")
            #expect(try recovered.sourceText() == updated)
            #expect(
                try recovered.project(expected: 4, range: EditorByteRange(start: 0, end: 15))
                    .links.first?.destination == "https://x.test")
            _ = try recovered.checkpoint()
            #expect(try store.read(id: "links") == updated)
            try recovered.detach()
        }.value
    }
    @Test("reference visibility and source selection survive native history and recovery")
    func referencesRecoverExactly() async throws {
        try await Task.detached {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "editor-references-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            let original = "[id]: <https://x.test> 'T'\n\nmiddle\n\n[one][id] end"
            let unlinked = "[id]: <https://x.test> 'T'\n\nmiddle\n\none end"
            _ = try store.createNote(title: "references", folder: "", content: original)
            let session = try store.openEditor(id: "references")
            _ = try session.selectWithAffinity(
                expected: 0, range: EditorByteRange(start: 9, end: 10), affinity: .forward)
            let target = try #require(
                try session.inspectLink(expected: 0, range: EditorByteRange(start: 8, end: 11)))
            #expect(target.destination == "https://x.test")
            #expect(target.title == "T")
            let change = try #require(
                try session.setLink(
                    expected: 0, range: EditorByteRange(start: 9, end: 10), destination: ""))
            var view = Array("middle\n\none end".utf8)
            view.replaceSubrange(
                Int(change.range.start)..<Int(change.range.end), with: change.inserted.utf8)
            #expect(String(decoding: view, as: UTF8.self) == unlinked)
            #expect(change.selection == EditorByteRange(start: 37, end: 38))
            #expect(try session.sourceText() == unlinked)
            let undone = try #require(try session.undo(expected: 1))
            #expect(undone.selection == EditorByteRange(start: 9, end: 10))
            #expect(try session.sourceText() == original)
            let redone = try #require(try session.redo(expected: 2))
            #expect(redone.selection == EditorByteRange(start: 37, end: 38))
            _ = try session.flushRecovery()
            try session.detach()
            let recovered = try store.openEditor(id: "references")
            #expect(try recovered.sourceText() == unlinked)
            #expect(
                try recovered.project(expected: 3, range: EditorByteRange(start: 0, end: 43)).text
                    == unlinked)
            _ = try recovered.checkpoint()
            #expect(try store.read(id: "references") == unlinked)
            try recovered.detach()
        }.value
    }

    @Test("URI class retirement retains Code and literal pre-Code history")
    func uriClassRetirement() async throws {
        try await Task.detached {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "editor-link-class-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(title: "Old", folder: "", content: "target")
            _ = try store.createNote(title: "plain", folder: "", content: "")
            let session = try store.openEditor(id: "plain")
            let old = "https://x.test/[[Old]]/path"
            let new = "https://x.test/[[New Name]]/path"
            let end = UInt64(old.utf8.count + 1)
            _ = try session.replaceUtf16(expected: 0, range: EditorUtf16Range(start: 0, end: 0), inserted: Array("<\(old)".utf16))
            _ = try session.replaceUtf16(expected: 1, range: EditorUtf16Range(start: end, end: end), inserted: [62])
            _ = try session.selectWithAffinity(expected: 2, range: EditorByteRange(start: 1, end: end), affinity: .backward)
            _ = try #require(try session.toggleFormat(expected: 2, format: .code))
            _ = try session.checkpoint()
            _ = try store.rename(oldId: "Old", newId: "New Name")
            let changes = try session.takeCoordinatedChanges()
            #expect(changes.count == 1)
            #expect(changes.first?.previousRevision == 3 && changes.first?.revision == 4)
            #expect(try session.takeCoordinatedChanges().isEmpty)
            let saved = "<`\(new)`>"
            let shown = "<\(new)>"
            let range = EditorByteRange(start: 0, end: UInt64(shown.utf8.count))
            #expect(try session.sourceText() == saved)
            let projected = try session.project(expected: 4, range: range)
            #expect(projected.text == shown && projected.links.isEmpty)
            #expect(projected.runs.filter { $0.formats.contains(.code) }.map(\.range) == [EditorByteRange(start: 1, end: UInt64(new.utf8.count + 1))])
            _ = try #require(try session.undo(expected: 4))
            let literal = try session.project(expected: 5, range: range)
            #expect(literal.text == shown && literal.links.isEmpty)
            #expect(literal.runs.allSatisfy { !$0.formats.contains(.code) })
            _ = try #require(try session.redo(expected: 5))
            #expect(try session.sourceText() == saved)
            _ = try session.flushRecovery()
            try session.detach()
            let recovered = try store.openEditor(id: "plain")
            #expect(try recovered.sourceText() == saved)
            #expect(try recovered.project(expected: 6, range: range).links.isEmpty)
            #expect(try recovered.undo(expected: 6) == nil)
            _ = try recovered.checkpoint()
            #expect(try store.read(id: "plain") == saved)
            try recovered.detach()
        }.value
    }

}

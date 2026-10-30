import Foundation
import Testing

@testable import FutoNotesNative

@Suite("Native block regression contract")
struct NativeEditorBlockRegressionTests {
    @Test("shared block commands return structure and preserve exact recovery bytes")
    func blockCommands() async throws {
        try await Task.detached {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "editor-blocks-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(title: "blocks", folder: "", content: "😀ab\r\ntail  \r\n")
            let session = try store.openEditor(id: "blocks")
            let heading = try session.blockCommandUtf16(
                expected: 0, range: EditorUtf16Range(start: 2, end: 2), command: .heading(level: 6))
            #expect(heading?.projection.blocks.first?.heading == 6)
            #expect(try session.sourceText() == "###### 😀ab\r\ntail  \r\n")
            _ = try session.paragraphKeyUtf16(
                expected: 1, range: EditorUtf16Range(start: 3, end: 3), key: .enter)
            #expect(try session.sourceText() == "###### 😀a\nb\r\ntail  \r\n")
            _ = try session.undo(expected: 2)
            _ = try session.redo(expected: 3)
            _ = try session.flushRecovery()
            try session.detach()
            let recovered = try store.openEditor(id: "blocks")
            #expect(try recovered.sourceText() == "###### 😀a\nb\r\ntail  \r\n")
            _ = try recovered.checkpoint()
            #expect(try store.read(id: "blocks") == "###### 😀a\nb\r\ntail  \r\n")
            try recovered.detach()
            _ = try store.createNote(title: "quote", folder: "", content: "> a")
            let quote = try store.openEditor(id: "quote")
            _ = try quote.blockCommandUtf16(
                expected: 0, range: EditorUtf16Range(start: 1, end: 1), command: .indent)
            #expect(try quote.sourceText() == "> > a")
            _ = try quote.blockCommandUtf16(
                expected: 1, range: EditorUtf16Range(start: 1, end: 1), command: .outdent)
            #expect(try quote.sourceText() == "> a")
            #expect(
                try quote.blockCommandUtf16(
                    expected: 2, range: EditorUtf16Range(start: 1, end: 1), command: .quote) == nil)
            let divider = try quote.blockCommandUtf16(
                expected: 2, range: EditorUtf16Range(start: 1, end: 1), command: .divider)
            #expect(divider?.projection.blocks.contains(where: { $0.divider }) == true)
            #expect(try quote.sourceText() == "> a\n> ***\n> ")
            #expect(try quote.displayText() == "a\n\u{fffc}\n")
            _ = try quote.flushRecovery()
            try quote.detach()
            let quotedRecovery = try store.openEditor(id: "quote")
            #expect(try quotedRecovery.sourceText() == "> a\n> ***\n> ")
            _ = try quotedRecovery.checkpoint()
            try quotedRecovery.detach()
            _ = try store.createNote(title: "shortcut", folder: "", content: "\\#A #\r\ntail  ")
            let shortcut = try store.openEditor(id: "shortcut")
            _ = try shortcut.selectUtf16(expected: 0, range: EditorUtf16Range(start: 1, end: 1))
            let converted = try shortcut.replaceUtf16(
                expected: 0, range: EditorUtf16Range(start: 1, end: 1), inserted: [32])
            #expect(converted.selection == EditorByteRange(start: 0, end: 0))
            #expect(try shortcut.sourceText() == "# A \\#\r\ntail  ")
            #expect(try shortcut.displayText() == "A #\r\ntail  ")
            _ = try shortcut.undo(expected: 1)
            #expect(try shortcut.sourceText() == "\\#A #\r\ntail  ")
            _ = try shortcut.redo(expected: 2)
            _ = try shortcut.flushRecovery()
            try shortcut.detach()
            let shortcutRecovery = try store.openEditor(id: "shortcut")
            #expect(try shortcutRecovery.sourceText() == "# A \\#\r\ntail  ")
            _ = try shortcutRecovery.checkpoint()
            #expect(try store.read(id: "shortcut") == "# A \\#\r\ntail  ")
            try shortcutRecovery.detach()
            _ = try store.createNote(title: "carry", folder: "", content: "# __ab__")
            let carry = try store.openEditor(id: "carry")
            _ = try carry.paragraphKeyUtf16(
                expected: 0, range: EditorUtf16Range(start: 2, end: 2), key: .enter)
            #expect(try carry.activeFormats() == [.bold])
            _ = try carry.replaceUtf16(
                expected: 1, range: EditorUtf16Range(start: 3, end: 3), inserted: [99])
            #expect(try carry.sourceText() == "# __ab__\n__c__")
            #expect(try carry.displayText() == "ab\nc")
            _ = try carry.flushRecovery()
            try carry.detach()
            let carryRecovery = try store.openEditor(id: "carry")
            #expect(try carryRecovery.sourceText() == "# __ab__\n__c__")
            _ = try carryRecovery.checkpoint()
            #expect(try store.read(id: "carry") == "# __ab__\n__c__")
            try carryRecovery.detach()
        }.value
    }

    @Test("block conversions preserve spaces, quote depth and physical setext prefixes")
    func blockRegressions() async throws {
        try await Task.detached {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "editor-block-regressions-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = NoteStore(notesRoot: root.path)
            let cases: [(String, EditorBlockCommand, String, String, UInt64)] = [
                ("   foo", .heading(level: 2), "## &#32;  foo", "   foo", 6),
                ("   # foo", .heading(level: 0), "foo", "foo", 0),
                ("> > ## 猫🦊 ##", .quote, "> > 猫🦊", "猫🦊", 0),
                (
                    "> foo\r\n> bar\r\n> ===", .heading(level: 0),
                    "> foo\r\n> bar", "foo\r\nbar", 5
                ),
            ]
            for (index, item) in cases.enumerated() {
                let (opening, command, expected, shown, caret) = item
                let id = "block-\(index)"
                _ = try store.createNote(title: id, folder: "", content: opening)
                let session = try store.openEditor(id: id)
                #expect(try session.displayText() == shown)
                let change = try #require(
                    try session.blockCommandUtf16(
                        expected: 0, range: EditorUtf16Range(start: caret, end: caret),
                        command: command))
                #expect(try session.sourceText() == expected)
                #expect(try session.displayText() == shown)
                #expect(change.selection.start == caret && change.selection.end == caret)
                _ = try session.undo(expected: 1)
                #expect(try session.sourceText() == opening)
                _ = try session.redo(expected: 2)
                _ = try session.flushRecovery()
                try session.detach()
                let recovered = try store.openEditor(id: id)
                #expect(try recovered.sourceText() == expected)
                #expect(try recovered.displayText() == shown)
                _ = try recovered.checkpoint()
                #expect(try store.read(id: id) == expected)
                try recovered.detach()
            }
        }.value
    }
    @Test("setext physical ownership and heading Enter preserve native ranges and recovery")
    func setextPhysicalOwnership() async throws {
        try await Task.detached {
            let cases: [(String, String, String, UInt64, UInt64, String, String, UInt64)] = [
                ("#x\n=", "#x", "text", 0, 2, "#x", "#x", 2),
                ("> x\n> y\n> =", "x\ny", "indent", 0, 3, "> > x\n> > y\n> > =", "x\ny", 3),
                (
                    "> > x\r\n> > y\r\n> > ---", "x\r\ny", "outdent", 0, 4,
                    "> x\r\n> y\r\n> ---", "x\r\ny", 4
                ),
                (
                    "> > 猫🦊\r\n> > e\u{301}\r\n> > ===", "猫🦊\r\ne\u{301}", "enter", 5, 5,
                    "> > 猫🦊\r\n> > ===\r\n\n> > e\u{301}", "猫🦊\r\n\ne\u{301}", 6
                ),
                ("> # x", "x", "enter", 0, 1, "> # \n> ", "\n", 1),
                ("> x\n> =", "x", "enter", 0, 1, "> # \n> ", "\n", 1),
                ("> x\n> =", "x", "delete", 0, 1, "> # ", "", 0),
            ]
            for (opening, shown, action, start, end, expected, display, caret) in cases {
                let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                    "editor-setext-\(UUID().uuidString)", isDirectory: true)
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: root) }
                let store = NoteStore(notesRoot: root.path)
                _ = try store.createNote(title: "setext", folder: "", content: opening)
                let session = try store.openEditor(id: "setext")
                #expect(try session.displayText() == shown)
                let selected = EditorUtf16Range(start: start, end: end)
                _ = try session.selectUtf16(expected: 0, range: selected)
                let change: EditorViewChange?
                switch action {
                case "enter":
                    change = try session.paragraphKeyUtf16(
                        expected: 0, range: selected, key: .enter)
                case "delete":
                    change = try session.replaceUtf16(expected: 0, range: selected, inserted: [])
                default:
                    let command: EditorBlockCommand =
                        action == "text"
                        ? .heading(level: 0)
                        : action == "indent" ? .indent : .outdent
                    change = try session.blockCommandUtf16(
                        expected: 0, range: selected, command: command)
                }
                let result = try #require(change)
                var view = Array(shown.utf8)
                view.replaceSubrange(
                    Int(result.range.start)..<Int(result.range.end), with: result.inserted.utf8)
                #expect(String(decoding: view, as: UTF8.self) == display)
                #expect(try session.sourceText() == expected)
                #expect(
                    try session.displayToUtf16(expected: 1, range: result.selection).end == caret)
                _ = try session.undo(expected: 1)
                #expect(try session.sourceText() == opening)
                _ = try session.redo(expected: 2)
                #expect(try session.sourceText() == expected)
                _ = try session.flushRecovery()
                try session.detach()
                let recovered = try store.openEditor(id: "setext")
                #expect(try recovered.sourceText() == expected)
                #expect(try recovered.displayText() == display)
                _ = try recovered.checkpoint()
                #expect(try store.read(id: "setext") == expected)
                try recovered.detach()
            }
        }.value
    }

    @Test("complete block bodies and returned carets survive exact recovery")
    func completeBodyOwnership() async throws {
        try await Task.detached {
            let cases: [(String, String, String, UInt64, UInt64, String, String, Bool)] = [
                (
                    "> a\n> b\n> =", "a\nb", "divider", 0, 0, "> ---\n> \n> a\n> b\n> =",
                    "\u{fffc}\n\na\nb", false
                ),
                ("> a\n> b\n> =", "a\nb", "divider", 0, 3, "> ---\n> ", "\u{fffc}\n", false),
                (
                    "> 猫🦊\n> e\u{301}z\n> ===", "猫🦊\ne\u{301}z", "divider", 7, 7,
                    "> 猫🦊\n> e\u{301}z\n> ===\n> ***\n> ", "猫🦊\ne\u{301}z\n\u{fffc}\n", false
                ),
                ("a\nb\n===", "a\nb", "heading", 0, 3, "### a b", "a b", false),
                (
                    "> ab ##\n> cd ###\n> ===", "ab ##\ncd ###", "heading", 0, 12,
                    "> ### ab ## cd \\###", "ab ## cd ###", false
                ),
                ("## x y", "x y", "delete", 0, 0, "## &#32;y", " y", false),
                ("## # ab", "# ab", "delete", 0, 0, "## &#32;ab", " ab", false),
                ("#x\n=", "#x", "backspace", 2, 2, "\\#\n=", "#", false),
                ("## x", "x", "space", 0, 1, "## &#32;", " ", false),
                ("x\n=", "x", "newline", 0, 1, "# \n", "\n", false),
                (
                    "> __ab\n> cd__", "ab\ncd", "enter", 1, 1, "> __a__\n>\n> __!b__\n> __cd__",
                    "a\n\n!b\ncd", true
                ),
                (
                    "> __ab\n> cd__\n> ===", "ab\ncd", "enter", 1, 1,
                    "> __a__\n> ===\n> __!b\n> cd__", "a\n!b\ncd", true
                ),
                (
                    "> `ab`\n> `cd`\n> ---", "ab\ncd", "delete", 3, 3, "> `ab`\n> `!d`\n> ---",
                    "ab\n!d", true
                ),
                (
                    "> ab\ncd\n> ===", "ab\ncd", "divider", 1, 4,
                    "> a\n> ===\n> ***\n> \n> d\n> ===", "a\n\u{fffc}\n\nd", false
                ),
                ("> ## # ab ##\n> ## cd ###", "# ab\ncd", "delete", 0, 7, "> ##  ! ###", "!", true),
                ("> ab\n> ===", "ab", "space", 0, 2, "> # &#32;", " ", false),
            ]
            for (opening, shown, action, start, end, expected, display, followup) in cases {
                let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                    "editor-owned-body-\(UUID().uuidString)", isDirectory: true)
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: root) }
                let store = NoteStore(notesRoot: root.path)
                _ = try store.createNote(title: "body", folder: "", content: opening)
                let session = try store.openEditor(id: "body")
                let selected = EditorUtf16Range(start: start, end: end)
                _ = try session.selectUtf16(expected: 0, range: selected)
                let change: EditorViewChange
                switch action {
                case "heading", "divider":
                    change = try #require(
                        try session.blockCommandUtf16(
                            expected: 0, range: selected,
                            command: action == "heading" ? .heading(level: 3) : .divider))
                case "space", "newline":
                    change = try session.replaceUtf16Action(
                        expected: 0, range: selected, inserted: action == "space" ? [32] : [10],
                        action: .isolated)
                default:
                    change = try #require(
                        try session.paragraphKeyUtf16(
                            expected: 0, range: selected,
                            key: action == "enter"
                                ? .enter : action == "delete" ? .delete : .backspace))
                }
                var view = Array(shown.utf8)
                view.replaceSubrange(
                    Int(change.range.start)..<Int(change.range.end), with: change.inserted.utf8)
                if followup {
                    let caret = try session.displayToUtf16(expected: 1, range: change.selection)
                    let next = try session.replaceUtf16Action(
                        expected: 1, range: caret, inserted: [33], action: .isolated)
                    view.replaceSubrange(
                        Int(next.range.start)..<Int(next.range.end), with: next.inserted.utf8)
                }
                #expect(String(decoding: view, as: UTF8.self) == display)
                #expect(try session.sourceText() == expected)
                _ = try session.undo(expected: session.revision())
                if followup { _ = try session.undo(expected: session.revision()) }
                #expect(try session.sourceText() == opening)
                _ = try session.redo(expected: session.revision())
                if followup { _ = try session.redo(expected: session.revision()) }
                #expect(try session.sourceText() == expected)
                _ = try session.flushRecovery()
                try session.detach()
                let recovered = try store.openEditor(id: "body")
                #expect(try recovered.sourceText() == expected)
                #expect(try recovered.displayText() == display)
                _ = try recovered.checkpoint()
                #expect(try store.read(id: "body") == expected)
                try recovered.detach()
            }
        }.value
    }

}

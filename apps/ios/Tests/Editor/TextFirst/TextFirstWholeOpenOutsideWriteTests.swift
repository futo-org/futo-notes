#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// Another writer changes a note while it opens whole (a short note, or a long one whose first
    /// screens are declined): nothing was shown, so the session opens on the file as it then is,
    /// as if the note had been read once, under its lease (#392 review).
    @Suite @MainActor
    struct TextFirstWholeOpenOutsideWriteTests {
        /// A note opened whole, as the note screen opens one whose first screens are not shown:
        /// one read, no quick view, `between` written before the session opens, then mounted and
        /// given `typing` once it settled.
        static func openWhole(
            _ source: String, between: String, typing: (TextFirstTextView) -> Void = { _ in }
        ) async throws -> (shown: String, files: [String: String]) {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "text-first-whole-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let store = NoteStore(notesRoot: root.path)
            _ = try store.createNote(title: "note", folder: "", content: source)
            let read = store.readForEditor(id: "note")
            #expect(store.quickOpenView(read: read) == nil)
            try between.write(
                to: root.appendingPathComponent("note.md"), atomically: true, encoding: .utf8)
            let controller = try TextFirstEditorController(
                noteId: "note", session: try store.openEditorRead(read: read), imageRoot: root)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
            controller.textView.frame = window.bounds
            window.addSubview(controller.textView)
            window.isHidden = false
            controller.textView.layoutIfNeeded()
            try await Task.sleep(nanoseconds: 300_000_000)
            typing(controller.textView)
            try await Task.sleep(nanoseconds: 300_000_000)
            let shown = controller.textView.text ?? ""
            #expect(shown == (try controller.session.displayText()))
            _ = await controller.close()
            var files: [String: String] = [:]
            for name in try FileManager.default.contentsOfDirectory(atPath: root.path)
            where name.hasSuffix(".md") {
                files[name] = try String(
                    contentsOf: root.appendingPathComponent(name), encoding: .utf8)
            }
            return (shown, files)
        }

        static let short = "# Title\n\nalpha line one\n\nbeta line two\n"
        static let shortPeer = "# Title\n\nalpha line one\n\nbeta PEER line two\n"

        @Test func aShortNoteChangedWhileOpeningShowsTheChange() async throws {
            let o = try await Self.openWhole(Self.short, between: Self.shortPeer)
            #expect(o.shown.contains("PEER"), "shows \(o.shown.debugDescription)")
            #expect(o.files == ["note.md": Self.shortPeer])
        }

        /// Typing where the outside write changed the line saves one note, as the user sees it.
        @Test func typingOnAShortNoteChangedWhileOpeningMakesNoConflictCopy() async throws {
            let o = try await Self.openWhole(Self.short, between: Self.shortPeer) { tv in
                let at = ((tv.text ?? "") as NSString).range(of: "beta").location + 4
                tv.selectedRange = NSRange(location: at, length: 0)
                for c in "αβ" {
                    if tv.delegate?.textView?(
                        tv, shouldChangeTextIn: tv.selectedRange, replacementText: String(c))
                        ?? true
                    {
                        tv.insertText(String(c))
                    }
                }
            }
            #expect(o.files == ["note.md": "# Title\n\nalpha line one\n\nbetaαβ PEER line two\n"])
        }

        /// A long note whose first screens are declined (line 1 `---` with no closing `---` in
        /// them: front matter or a divider, the rest of the note decides) opens whole.
        @Test func aDeclinedLongNoteChangedWhileOpeningShowsTheChange() async throws {
            let source =
                "---\n" + (0..<700).map { "## Section \($0)\n\nBody \($0) here.\n\n" }.joined()
            let o = try await Self.openWhole(source, between: "# PEER heading\n\n" + source)
            #expect(
                o.shown.hasPrefix("PEER heading"), "shows \(o.shown.prefix(30).debugDescription)")
        }
    }
#endif

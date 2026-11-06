#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// A real text-first editor on a real vault, in a window, for driving UITextInput calls.
    @MainActor
    final class TextFirstHarness {
        let root: URL
        let store: NoteStore
        let controller: TextFirstEditorController
        let window: UIWindow
        var tv: TextFirstTextView { controller.textView }

        init(_ source: String, id: String = "note") {
            root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "text-first-\(UUID().uuidString)")
            try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            store = NoteStore(notesRoot: root.path)
            _ = try! store.createNote(title: id, folder: "", content: source)
            controller = try! TextFirstEditorController(
                noteId: id, session: try! store.openEditor(id: id))
            controller.verifyDivergence = true
            window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
            tv.frame = window.bounds
            window.addSubview(tv)
            window.isHidden = false
            _ = tv.becomeFirstResponder()
        }

        
        /// The store writes every note with a final line ending; the rows are written without one.
        static func trimmed(_ text: String) -> String {
            text.hasSuffix("\n") && !text.hasSuffix("\n\n") ? String(text.dropLast()) : text
        }
        var source: String { Self.trimmed(try! controller.session.sourceText()) }
        var display: String { Self.trimmed(tv.text ?? "") }
        var isComposing: Bool { (try? controller.session.composition()).flatMap { $0 } != nil }

        func select(_ a: Int, _ b: Int) { tv.selectedRange = NSRange(location: a, length: b - a) }

        /// One keyboard key: the delegate is asked first, as UIKeyboardImpl does, then UIKit inserts.
        func type(_ text: String) {
            for character in text {
                let s = String(character)
                if tv.delegate?.textView?(
                    tv, shouldChangeTextIn: tv.selectedRange, replacementText: s) ?? true
                {
                    tv.insertText(s)
                }
            }
        }

        /// Re-attach a fresh editor to the same vault (the previous one must be detached).
        func reopen(id: String = "note") throws -> TextFirstHarness {
            TextFirstHarness(root: root, id: id)
        }

        init(root: URL, id: String) {
            self.root = root
            store = NoteStore(notesRoot: root.path)
            controller = try! TextFirstEditorController(
                noteId: id, session: try! store.openEditor(id: id))
            controller.verifyDivergence = true
            window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
            tv.frame = window.bounds
            window.addSubview(tv)
            window.isHidden = false
            _ = tv.becomeFirstResponder()
        }
    }
#endif

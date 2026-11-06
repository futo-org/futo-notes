#if FUTO_DEBUG_BUILD
    import UIKit

    /// The text-first editor's view: a TextKit 2 `UITextView` that holds display text only.
    /// What the engine decides (Enter, a caret's Backspace, undo, the clipboard) is routed to
    /// the controller; everything else is UIKit's, reported through the delegate.
    final class TextFirstTextView: UITextView {
        weak var controller: TextFirstEditorController?
        private lazy var engineUndo = TextFirstUndoManager()

        /// All undo goes to the engine; UIKit's own registration is off.
        override var undoManager: UndoManager? {
            engineUndo.controller = controller
            return engineUndo
        }

        /// A caret's Backspace is the engine's (it lifts list markers, never deletes only hidden
        /// bytes). A selection's goes to UIKit, so its smart delete (the space beside a deleted
        /// word) reaches the engine as an ordinary platform edit. At a heading's start the engine joins
        /// the line up (or demotes a first-line heading); elsewhere it is a plain Backspace.
        override func deleteBackward() {
            guard markedTextRange == nil, selectedRange.length == 0, let controller,
                controller.paragraphKey(.backspaceJoiningHeading)
            else {
                super.deleteBackward()
                return
            }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            controller?.images.widthChanged()
            controller?.tablesWidthChanged()
        }

        override func becomeFirstResponder() -> Bool {
            if controller?.suppressFocus == true { return false }
            return super.becomeFirstResponder()
        }

        override func unmarkText() {
            super.unmarkText()
            controller?.platformUnmarked()
        }

        /// An image alone on the pasteboard is pasteable too (it becomes a vault image).
        override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
            if action == #selector(paste(_:)), UIPasteboard.general.hasImages,
                !UIPasteboard.general.hasStrings
            {
                return true
            }
            return super.canPerformAction(action, withSender: sender)
        }

        override func copy(_ sender: Any?) { controller?.copySelection() }
        override func cut(_ sender: Any?) { controller?.cutSelection() }
        override func paste(_ sender: Any?) { controller?.pasteFromPasteboard() }

        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            if let key = presses.first?.key, markedTextRange == nil, let controller {
                // A caret's forward Delete is the engine's; Tab and Shift-Tab indent and outdent
                // a list item, and anywhere else are UIKit's.
                if key.keyCode == .keyboardDeleteForward, selectedRange.length == 0,
                    controller.paragraphKey(.delete)
                {
                    return
                }
                if key.keyCode == .keyboardTab,
                    controller.paragraphKey(
                        key.modifierFlags.contains(.shift) ? .shiftTab : .tab, onlyIfChanged: true)
                {
                    return
                }
            }
            super.pressesBegan(presses, with: event)
        }
    }

    /// Routes shake, Cmd+Z and the three-finger gesture to the engine.
    final class TextFirstUndoManager: UndoManager {
        weak var controller: TextFirstEditorController?
        override init() {
            super.init()
            disableUndoRegistration()
        }
        override var canUndo: Bool { true }
        override var canRedo: Bool { true }
        override func undo() { MainActor.assumeIsolated { controller?.undo() } }
        override func redo() { MainActor.assumeIsolated { controller?.redo() } }
    }
#endif

#if FUTO_DEBUG_BUILD
    extension TextFirstTextView {
        /// UIKit's own value converts the whole attributed string to its accessibility form after
        /// every edit once the accessibility server has touched the app: one keystroke cost
        /// O(document) (about 40 ms at 20k lines in the proof). The plain text is the same words.
        override var accessibilityValue: String? {
            get { text }
            set {}
        }
    }
#endif

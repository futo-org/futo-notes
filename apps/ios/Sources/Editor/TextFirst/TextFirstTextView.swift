#if FUTO_DEBUG_BUILD
    import UIKit
    import UIKit.UIGestureRecognizerSubclass

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
            // The engine has not landed: the view stays as it was shown, and the key waits.
            if let controller, controller.opening {
                controller.queueDeleteWhileOpening(forward: false)
                return
            }
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
            controller?.cellEditor?.reposition()
        }

        // MARK: long notes
        //
        // TextKit 2 lays out only the viewport and places it from an estimate of the heights above
        // it. Any layout request far from the viewport re-bases that estimate (a 20,000-line note
        // is estimated 28% short, and the estimate moves by 100,000 pt as it is refined), and
        // UIKit's tap handling makes two such requests before it places the caret.

        /// A finger is on the text view (the controller's touch tracker sets it).
        var fingerIsDown = false

        /// The UTF-16 offsets of the text the viewport lays out: the only text that is on screen.
        private var viewportOffsets: Range<Int>? {
            guard let manager = textLayoutManager,
                let viewport = manager.textViewportLayoutController.viewportRange
            else { return nil }
            let start = manager.documentRange.location
            return manager.offset(
                from: start, to: viewport.location)..<manager.offset(
                    from: start, to: viewport.endLocation)
        }

        /// Where a position outside the viewport would be, as a y outside the visible area:
        /// negative above the viewport, positive below it, nil when it is in the viewport.
        private func side(of position: UITextPosition) -> Int? {
            guard let shown = viewportOffsets else { return nil }
            let offset = self.offset(from: beginningOfDocument, to: position)
            return offset < shown.lowerBound ? -1 : offset > shown.upperBound ? 1 : nil
        }

        /// UIKit's tap handling first probes the origin, to have the document laid out before it
        /// selects. While the viewport is elsewhere, laying out the first lines re-bases the
        /// estimate, and the hit test of the same tap then lands past the end of the document and
        /// puts the caret there. A point above the first line is the start of the document, so
        /// that probe is answered without a layout.
        override func closestPosition(to point: CGPoint) -> UITextPosition? {
            if point.y < textContainerInset.top, let shown = viewportOffsets, shown.lowerBound > 0 {
                return beginningOfDocument
            }
            return super.closestPosition(to: point)
        }

        /// While a finger is down UIKit also asks where the previous caret was, to see whether
        /// the touch is on it. That caret is off screen, and laying out around it re-bases the
        /// estimate again (the view jumps thousands of points). It cannot be under a finger, so
        /// the answer comes from outside the visible area, without a layout.
        override func caretRect(for position: UITextPosition) -> CGRect {
            guard fingerIsDown, let side = side(of: position) else {
                let proposed = super.caretRect(for: position)
                guard let controller, side(of: position) == nil,
                    let drawn = controller.imageLineCaret(
                        at: offset(from: beginningOfDocument, to: position), proposed: proposed)
                else { return proposed }
                return drawn
            }
            return CGRect(
                x: textContainerInset.left,
                y: contentOffset.y + (side < 0 ? -bounds.height : 2 * bounds.height),
                width: 2, height: 20)
        }

        override func selectionRects(for range: UITextRange) -> [UITextSelectionRect] {
            if fingerIsDown, let side = side(of: range.start), side == self.side(of: range.end) {
                return []
            }
            let rects = super.selectionRects(for: range)
            guard let controller else { return rects }
            // On an image's line the rects, and the handles drawn from them, are as tall as text.
            return rects.map { rect in
                controller.onImageLine(rect.rect).map { TextFirstSelectionRect(rect, drawnAs: $0) }
                    ?? rect
            }
        }

        // While the engine has not landed UIKit must never change the frozen view: a keyboard's
        // text, an autocorrect's replacement and a Return all reach the queue instead, and marked
        // text is held until the keyboard commits it.
        override func insertText(_ text: String) {
            if let controller, controller.opening {
                controller.insertWhileOpening(text)
                return
            }
            super.insertText(text)
        }

        override func replace(_ range: UITextRange, withText text: String) {
            if let controller, controller.opening {
                let start = offset(from: beginningOfDocument, to: range.start)
                controller.queueWhileOpening(
                    NSRange(location: start, length: offset(from: range.start, to: range.end)),
                    text)
                return
            }
            super.replace(range, withText: text)
        }

        override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
            if let controller, controller.opening {
                controller.holdMarkedWhileOpening(markedText)
                return
            }
            super.setMarkedText(markedText, selectedRange: selectedRange)
        }

        @discardableResult override func becomeFirstResponder() -> Bool {
            if controller?.suppressFocus == true { return false }
            return super.becomeFirstResponder()
        }

        @discardableResult override func resignFirstResponder() -> Bool {
            return super.resignFirstResponder()
        }

        override func unmarkText() {
            if let controller, controller.opening {
                controller.commitMarkedWhileOpening()
                return
            }
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

        override func selectAll(_ sender: Any?) {
            if let controller, controller.selectAll() { return }
            super.selectAll(sender)
        }

        override func copy(_ sender: Any?) { controller?.copySelection() }
        override func cut(_ sender: Any?) { controller?.cutSelection() }
        override func paste(_ sender: Any?) { controller?.pasteFromPasteboard() }

        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            if let key = presses.first?.key, markedTextRange == nil, let controller {
                if controller.opening, key.keyCode == .keyboardDeleteForward {
                    controller.queueDeleteWhileOpening(forward: true)
                    return
                }
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

    /// UIKit's selection rect with a different frame.
    final class TextFirstSelectionRect: UITextSelectionRect {
        private let source: UITextSelectionRect
        private let frame: CGRect
        init(_ source: UITextSelectionRect, drawnAs frame: CGRect) {
            self.source = source
            self.frame = frame
            super.init()
        }
        override var rect: CGRect { frame }
        override var writingDirection: NSWritingDirection { source.writingDirection }
        override var containsStart: Bool { source.containsStart }
        override var containsEnd: Bool { source.containsEnd }
        override var isVertical: Bool { source.isVertical }
    }

    /// Reports a finger on the text view, from its first touch down to the end of the last, and
    /// never recognizes anything, so it takes nothing from the recognizers that do the work.
    final class TextFirstTouchTracker: UIGestureRecognizer {
        var onChange: (Bool) -> Void = { _ in }

        override init(target: Any?, action: Selector?) {
            super.init(target: target, action: action)
            cancelsTouchesInView = false
            delaysTouchesBegan = false
            delaysTouchesEnded = false
        }

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            onChange(true)
        }
        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { finish() }
        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { finish() }

        /// UIKit's own recognizers act inside this same event; the flag drops after them.
        private func finish() {
            state = .failed
            DispatchQueue.main.async { [onChange] in onChange(false) }
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

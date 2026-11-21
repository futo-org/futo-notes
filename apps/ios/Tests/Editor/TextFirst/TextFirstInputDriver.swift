#if DEBUG
    import UIKit

    @testable import FutoNotesNative

    /// One UITextInput call, as a keyboard or a system text service makes it.
    enum InputCall: Sendable {
        case select(Int, Int)
        case insert(String)  // insertText
        /// setMarkedText; `whole` = the clause is selected (a conversion candidate).
        case mark(String, whole: Bool = false)
        case unmark  // unmarkText
        case replace(Int, Int, String)  // replace(_:withText:)
        /// replace(_:withText:) over the n characters before the caret.
        case replaceBefore(Int, String)
        case backspace  // deleteBackward
        /// insertDictationResultPlaceholder, the result, removeDictationResultPlaceholder.
        case dictation([String])
        case dictationRemoveFirst([String])  // placeholder, remove(willInsertResult: true), result
        case textPlaceholder(String)  // insertTextPlaceholder(with:), remove(_:), insertText
    }

    enum Asking: Sendable, CaseIterable { case keyboard, bare }

    /// A dictation result phrase (UIKit only hands these out; the test makes its own).
    private final class Phrase: UIDictationPhrase {
        private let value: String
        init(_ value: String) {
            self.value = value
            super.init()
        }
        override var text: String { value }
    }

    /// Makes `InputCall`s on a view as the keyboard (delegate asked first) or a bare system
    /// service would. The random input suite drives the same calls.
    @MainActor
    struct InputDriver {
        let asking: Asking

        private func nsRange(_ tv: UITextView, _ a: Int, _ b: Int) -> UITextRange {
            tv.textRange(
                from: tv.position(from: tv.beginningOfDocument, offset: a)!,
                to: tv.position(from: tv.beginningOfDocument, offset: b)!)!
        }

        /// The range a keyboard names when it asks the delegate: the marked text, else the selection.
        private func current(_ tv: UITextView) -> NSRange {
            guard let m = tv.markedTextRange else { return tv.selectedRange }
            let s = tv.offset(from: tv.beginningOfDocument, to: m.start)
            return NSRange(location: s, length: tv.offset(from: m.start, to: m.end))
        }

        /// True when UIKit goes on to insert (the delegate may take the key itself, as Enter is).
        @discardableResult
        func ask(_ tv: UITextView, _ range: NSRange, _ text: String) -> Bool {
            guard asking == .keyboard else { return true }
            return tv.delegate?.textView?(tv, shouldChangeTextIn: range, replacementText: text)
                ?? true
        }

        /// The result as UIKit's dictation delivers it: through insertDictationResult(_:) when the
        /// view has one (UITextView has none, and calling it raises), else insertText of the phrases.
        private func insertResult(_ phrases: [String], _ tv: UITextView) {
            guard tv.responds(to: #selector(UITextInput.insertDictationResult(_:))) else {
                if ask(tv, current(tv), phrases.joined()) { tv.insertText(phrases.joined()) }
                return
            }
            tv.insertDictationResult(phrases.map(Phrase.init))
        }

        func apply(_ call: InputCall, to tv: UITextView) {
            switch call {
            case .select(let a, let b):
                tv.selectedRange = NSRange(location: a, length: b - a)
            case .insert(let t):
                if ask(tv, current(tv), t) { tv.insertText(t) }
            case .mark(let t, let whole):
                ask(tv, current(tv), t)
                let n = (t as NSString).length
                tv.setMarkedText(
                    t,
                    selectedRange: whole
                        ? NSRange(location: 0, length: n) : NSRange(location: n, length: 0))
            case .unmark:
                tv.unmarkText()
            case .replace(let a, let b, let t):
                if ask(tv, NSRange(location: a, length: b - a), t) {
                    tv.replace(nsRange(tv, a, b), withText: t)
                }
            case .replaceBefore(let n, let t):
                let caret = tv.selectedRange.location
                if ask(tv, NSRange(location: caret - n, length: n), t) {
                    tv.replace(nsRange(tv, caret - n, caret), withText: t)
                }
            case .backspace:
                tv.deleteBackward()
            case .dictation(let phrases):
                let p: Any = tv.insertDictationResultPlaceholder
                insertResult(phrases, tv)
                tv.removeDictationResultPlaceholder(p, willInsertResult: false)
            case .dictationRemoveFirst(let phrases):
                let p: Any = tv.insertDictationResultPlaceholder
                tv.removeDictationResultPlaceholder(p, willInsertResult: true)
                insertResult(phrases, tv)
            case .textPlaceholder(let t):
                let p = tv.insertTextPlaceholder(with: CGSize(width: 40, height: 20))
                tv.remove(p)
                if ask(tv, current(tv), t) { tv.insertText(t) }
            }
        }
    }
#endif

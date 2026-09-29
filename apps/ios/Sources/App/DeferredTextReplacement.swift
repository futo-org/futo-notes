import UIKit

extension UITextInput {
    /// Replaces `range` with `text` through UITextInput, so it is one ordinary undo
    /// step, once UIKit has finished the edit it is currently asking a delegate
    /// about. Replacing from inside `shouldChangeCharactersIn` / `shouldChangeTextIn`
    /// desyncs UIKit's own paste bookkeeping: the caret stays before the pasted
    /// text and the next undo replays a range past the end.
    func replaceAfterCurrentEdit(
        _ range: NSRange, with text: String, then completion: @escaping () -> Void = {}
    ) {
        DispatchQueue.main.async { [weak self] in
            guard let self,
                let start = position(from: beginningOfDocument, offset: range.location),
                let end = position(from: start, offset: range.length),
                let textRange = textRange(from: start, to: end)
            else { return }
            replace(textRange, withText: text)
            completion()
        }
    }
}

import UIKit

extension NSString {
    /// The longest prefix of `replacement` that keeps this text at most `limit`
    /// characters once it replaces `range`. Character counts are not additive —
    /// removing text can join its neighbours into one character, and inserted
    /// text can join them (a combining accent costs nothing) — so only the whole
    /// result is measured.
    func longestPrefix(of replacement: String, replacing range: NSRange, within limit: Int)
        -> String
    {
        let characters = Array(replacement)
        func fits(_ length: Int) -> Bool {
            replacingCharacters(in: range, with: String(characters.prefix(length))).count <= limit
        }
        if fits(characters.count) { return replacement }
        // ponytail: binary search assumes the result never shrinks as the prefix
        // grows; where a grapheme join breaks that, it only under-fills, since
        // every prefix it returns (except empty) was measured to fit.
        var fitting = 0
        var overflowing = characters.count
        while overflowing - fitting > 1 {
            let middle = (fitting + overflowing) / 2
            if fits(middle) { fitting = middle } else { overflowing = middle }
        }
        return String(characters.prefix(fitting))
    }
}

extension UITextInput {
    /// Replaces `range` with `text` through UITextInput, so it is one ordinary undo
    /// step, once UIKit has finished the edit it is currently asking a delegate
    /// about. Replacing from inside `shouldChangeCharactersIn` / `shouldChangeTextIn`
    /// desyncs UIKit's own paste bookkeeping: the caret stays before the pasted
    /// text and the next undo replays a range past the end. If anything edits the
    /// text first, the range no longer means what it did, so the replacement is dropped.
    func replaceAfterCurrentEdit(
        _ range: NSRange, with text: String, then completion: @escaping () -> Void = {}
    ) {
        let textWhenRequested = wholeTextUTF16
        DispatchQueue.main.async { [weak self] in
            guard let self, wholeTextUTF16 == textWhenRequested,
                let start = position(from: beginningOfDocument, offset: range.location),
                let end = position(from: start, offset: range.length),
                let textRange = textRange(from: start, to: end)
            else { return }
            replace(textRange, withText: text)
            completion()
        }
    }

    /// Exact code units: Swift `String ==` treats "e" + U+0301 and "é" as equal,
    /// though they give the same range different meanings.
    private var wholeTextUTF16: [UInt16]? {
        textRange(from: beginningOfDocument, to: endOfDocument)
            .flatMap { text(in: $0) }
            .map { Array($0.utf16) }
    }
}

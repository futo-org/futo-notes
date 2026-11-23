import UIKit

// The keyboard decides whether to capitalise (when the user's Auto-Capitalization setting does)
// from the text before the caret, which it reads through `text(in:)`. Right after a list item's
// marker unit that text ends in the unit's U+FFFC, which the keyboard reads as the middle of a
// sentence. The item's text starts its line as a plain line's does, so the keyboard is given the
// line break that line follows instead; the app itself never changes what is typed.

extension TextFirstEditorController {
    /// `text`, the view's text over `range`, as the keyboard should read it: unchanged unless the
    /// range ends at the caret right after a marker unit.
    func keyboardText(_ text: String, in range: NSRange) -> String {
        let caret = textView.selectedRange
        guard caret.length == 0, range.length > 0, NSMaxRange(range) == caret.location,
            isMarkerUnit(endingAt: caret.location), text.utf16.last == 0xFFFC
        else { return text }
        let units = text as NSString
        return units.replacingCharacters(
            in: NSRange(location: units.length - 1, length: 1), with: "\n")
    }
}

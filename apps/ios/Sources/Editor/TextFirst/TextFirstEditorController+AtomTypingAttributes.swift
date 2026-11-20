import UIKit

extension TextFirstEditorController {
    /// A caret just after an image or a list item's marker unit is offered that atom's hidden
    /// attributes (an image's 0.01 pt clear spelling, a marker's clear U+FFFC), and UIKit
    /// drops the editor's own keys from them, so they cannot be recognised by those. Marked text
    /// (an IME's composition, dictation) is drawn with them until it is committed, so it would be
    /// invisible. The look is the atom's, never the text's.
    func syncAtomTypingAttributes() {
        let caret = textView.selectedRange
        guard caret.length == 0,
            image(endingAt: caret.location) != nil || isMarkerUnit(endingAt: caret.location)
        else { return }
        textView.typingAttributes = Self.withoutAtomLook(textView.typingAttributes)
    }

    /// `attributes` without what hides an image's spelling or a marker unit; anything else (a
    /// toolbar toggle's bold, a paragraph's indent) is kept.
    static func withoutAtomLook(_ attributes: [NSAttributedString.Key: Any])
        -> [NSAttributedString.Key: Any]
    {
        var plain = attributes
        if let font = plain[.font] as? UIFont, font.pointSize <= 1 {
            plain[.font] = bodyFont
        }
        if (plain[.foregroundColor] as? UIColor) == UIColor.clear {
            plain[.foregroundColor] = baseAttributes[.foregroundColor]
        }
        plain[.kern] = nil
        plain[.baselineOffset] = nil
        plain[.tfImage] = nil
        plain[.tfListMarker] = nil
        return plain
    }

    private func isMarkerUnit(endingAt offset: Int) -> Bool {
        offset > 0 && offset <= storage.length
            && storage.attribute(.tfListMarker, at: offset - 1, effectiveRange: nil) != nil
    }
}

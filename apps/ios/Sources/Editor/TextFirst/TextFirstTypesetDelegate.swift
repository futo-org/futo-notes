import UIKit

/// Hands TextKit each paragraph holding an image or a list marker unit typeset differently
/// from the storage, one UTF-16 unit for one, so the storage, the display text and every
/// offset are untouched; only the string being typeset differs.
///
/// An image's spelling starts with `!`, and UAX #14 never breaks before `!`, even after a
/// space, so "world ![](x.png)" was one unbreakable word: a photo too wide for its line pushed
/// "world" (and then "Hello") down with it and was split off last. Its first character is
/// typeset as one the typesetter may break before, hidden like the rest of the spelling.
///
/// A list item's marker unit is typeset as a clear attachment as wide as the item's marker
/// column, so it is one glyph with that advance: its caret stops are the column's two edges
/// and a tap splits at its middle. A kern widens a glyph too, but TextKit puts the caret after
/// a kerned glyph halfway across the kern.
final class TextFirstTypesetDelegate: NSObject, NSTextContentStorageDelegate {
    /// U+02C8: class BB (a break may come before it, never after), one UTF-16 unit, and narrower
    /// than `!` in the hidden font, so the line the kern was sized for still fits the image.
    static let breakBefore = "\u{02C8}"

    func textContentStorage(
        _ textContentStorage: NSTextContentStorage, textParagraphWith range: NSRange
    ) -> NSTextParagraph? {
        guard let storage = textContentStorage.textStorage else { return nil }
        var typeset: NSMutableAttributedString?
        func shown() -> NSMutableAttributedString {
            let made =
                typeset
                ?? NSMutableAttributedString(
                    attributedString: storage.attributedSubstring(from: range))
            typeset = made
            return made
        }
        storage.enumerateAttribute(.tfImage, in: range) { value, run, _ in
            guard value is TextFirstImageSpan,
                (storage.string as NSString).character(at: run.location) == 0x21
            else { return }
            shown().replaceCharacters(
                in: NSRange(location: run.location - range.location, length: 1),
                with: Self.breakBefore)
        }
        storage.enumerateAttribute(.tfListMarker, in: range) { value, run, _ in
            guard value != nil,
                let block = storage.attribute(.tfBlock, at: run.location, effectiveRange: nil)
                    as? TextFirstBlockAttribute
            else { return }
            shown().addAttribute(
                .attachment, value: Self.markerAttachment(width: block.markerColumn),
                range: NSRange(location: run.location - range.location, length: run.length))
        }
        return typeset.map { NSTextParagraph(attributedString: $0) }
    }

    private static let clear = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1)).image {
        _ in
    }
    nonisolated(unsafe) private static var attachments: [CGFloat: NSTextAttachment] = [:]

    /// A clear attachment `width` wide that adds no height to its line. One per width.
    private static func markerAttachment(width: CGFloat) -> NSTextAttachment {
        if let known = attachments[width] { return known }
        let made = NSTextAttachment(image: clear)
        made.bounds = CGRect(x: 0, y: 0, width: width, height: 1)
        attachments[width] = made
        return made
    }
}

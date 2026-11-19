import UIKit

// A lifted block laid out on its own, off screen (#449 review). The editor lays out only what
// is near the screen, and laying out text far above it moves what shows (TextKit settles its
// estimates). A block running beyond what is laid out, or carried away from its own place, is
// laid out a second time in its own TextKit stack instead, with the note's width, attributes
// and line breaking and its lines above and below for their spacing: that gives its height
// and draws any stretch of it for the copy in the gap. It costs the block's layout once.

@MainActor
final class TextFirstBlockLayout {
    /// The block (UTF-16, in the note) and the width it was laid out for.
    let range: NSRange
    let width: CGFloat
    /// Its height, its top's y to its foot's (the next line's top).
    let height: CGFloat
    private let manager: NSTextLayoutManager
    private let content: NSTextContentStorage
    /// Where the block starts in the stack's text, and its first fragment's top there.
    private let start: Int
    private let top: CGFloat
    /// Retained: the stack holds its delegates weakly.
    private let layoutDelegate = TextFirstLayoutDelegate()
    private let breakDelegate = TextFirstImageBreakDelegate()

    /// `block` of `storage` laid out `width` wide, with the line above and the line below it.
    init?(_ storage: NSTextStorage, block: NSRange, width: CGFloat) {
        let text = storage.string as NSString
        let above =
            block.location > 0
            ? text.lineRange(for: NSRange(location: block.location - 1, length: 0))
            : NSRange(location: 0, length: 0)
        let below =
            NSMaxRange(block) < text.length
            ? text.lineRange(for: NSRange(location: NSMaxRange(block), length: 0))
            : NSRange(location: text.length, length: 0)
        let whole = NSMutableAttributedString(
            attributedString: storage.attributedSubstring(
                from: NSRange(location: above.location, length: NSMaxRange(below) - above.location)
            ))
        content = NSTextContentStorage()
        content.delegate = breakDelegate
        manager = NSTextLayoutManager()
        manager.delegate = layoutDelegate
        content.addTextLayoutManager(manager)
        let container = NSTextContainer(size: CGSize(width: width, height: 0))
        container.lineFragmentPadding = 0
        manager.textContainer = container
        content.textStorage?.setAttributedString(whole)
        manager.ensureLayout(for: manager.documentRange)
        start = block.location - above.location
        guard let first = Self.fragment(manager, content, at: start) else { return nil }
        top = first.layoutFragmentFrame.minY
        let foot: CGFloat
        if below.length > 0, let next = Self.fragment(manager, content, at: start + block.length) {
            foot = next.layoutFragmentFrame.minY
        } else {
            var last = first.layoutFragmentFrame.maxY
            manager.enumerateTextLayoutFragments(from: first.rangeInElement.location) {
                last = max(last, $0.layoutFragmentFrame.maxY)
                return true
            }
            foot = last
        }
        (range, self.width, height) = (block, width, foot - top)
    }

    private static func fragment(
        _ manager: NSTextLayoutManager, _ content: NSTextContentStorage, at offset: Int
    ) -> NSTextLayoutFragment? {
        content.location(content.documentRange.location, offsetBy: offset)
            .flatMap { manager.textLayoutFragment(for: $0) }
    }

    /// The top of the line holding the note's UTF-16 `offset`, below the block's top; nil
    /// outside the block.
    func y(ofLineAt offset: Int) -> CGFloat? {
        guard NSLocationInRange(offset, range),
            let f = Self.fragment(manager, content, at: start + offset - range.location)
        else { return nil }
        return f.layoutFragmentFrame.minY - top
    }

    /// `rect` (text view coordinates) as `painter` draws the note, the block's top at
    /// `blockTop`, over the surface colour.
    func paint(_ rect: CGRect, blockTop: CGFloat, with painter: TextFirstSlicePainter)
        -> CGImage?
    {
        let laidOut = painter.textView.textContainerInset.top + top
        let first = Self.fragment(manager, content, at: start)?.rangeInElement.location
        return painter.draw(
            rect, shift: blockTop - laidOut,
            fragments: { visit in
                guard let first else { return }
                manager.enumerateTextLayoutFragments(from: first) { visit($0) }
            })
    }
}

import UIKit

// A lifted block laid out on its own, off screen (#449 review). The editor lays out only what
// is near the screen, and laying out text far above it moves what shows (TextKit settles its
// estimates). A block running beyond what is laid out, or carried away from its own place, is
// laid out a second time in its own TextKit stack instead, with the note's width, attributes
// and line breaking and its lines above and below for their spacing: that gives its height
// and draws any stretch of it for the copy in the gap. A block of up to `whole` UTF-16 units
// is laid out at once (its height exact); a longer one (a quote thousands of lines long) only
// its first stretch, its height estimated from it, and any other stretch the copy shows is
// laid out when it is drawn, where the estimate puts it (#449 review: the lift stays quick).

@MainActor
final class TextFirstBlockLayout {
    /// The longest block laid out whole at the lift, in UTF-16 units (about 13 ms on the
    /// simulator; 160,000 took 110 ms).
    static let whole = 20_000
    /// The block (UTF-16, in the note), and the width and the images' drawing
    /// (`drawingSignature`) it was laid out for.
    let range: NSRange
    let width: CGFloat
    let drawing: Int
    /// Its height, its top's y to its foot's (the next line's top): estimated for a block
    /// longer than `whole`.
    let height: CGFloat
    /// The block, or its first stretch, laid out; and the stretch the copy last needed.
    private let head: TextFirstLaidOutLines
    private var stretch: (lines: TextFirstLaidOutLines, top: CGFloat)?
    private let storage: NSTextStorage
    private weak var host: TextFirstEditorController?

    /// `block` of `storage` laid out `width` wide, drawn as the editor `host` draws it (a
    /// table scrolled as it is there).
    init?(
        _ storage: NSTextStorage, block: NSRange, width: CGFloat, drawing: Int,
        host: TextFirstEditorController
    ) {
        let text = storage.string as NSString
        var first = block
        if block.length > Self.whole {
            let end = NSMaxRange(text.noteLine(at: block.location + Self.whole))
            first.length = min(end, NSMaxRange(block)) - block.location
        }
        guard
            let head = TextFirstLaidOutLines(storage, first, width: width, host: host),
            head.height > 0
        else { return nil }
        (self.head, self.storage, self.host) = (head, storage, host)
        (range, self.width, self.drawing) = (block, width, drawing)
        height = head.height * CGFloat(block.length) / CGFloat(first.length)
    }

    /// The top of the line holding the note's UTF-16 `offset`, below the block's top; nil
    /// outside the block. Beyond the first stretch of a long block, where the estimate puts
    /// it.
    func y(ofLineAt offset: Int) -> CGFloat? {
        guard NSLocationInRange(offset, range) else { return nil }
        if NSLocationInRange(offset, head.range) { return head.y(ofLineAt: offset) }
        let line = (storage.string as NSString).noteLine(at: offset).location
        return estimate(line)
    }

    private func estimate(_ offset: Int) -> CGFloat {
        height * CGFloat(offset - range.location) / CGFloat(range.length)
    }

    /// `rect` (text view coordinates) as `painter` draws the note, the block's top at
    /// `blockTop`, over the surface colour.
    func paint(_ rect: CGRect, blockTop: CGFloat, with painter: TextFirstSlicePainter)
        -> CGImage?
    {
        let band = (rect.minY - blockTop)...(rect.maxY - blockTop)
        if band.upperBound <= head.height + 1 {
            return head.paint(rect, top: blockTop, with: painter)
        }
        // Beyond the first stretch: the lines the estimate puts there, and a screen of them
        // more, laid out when first drawn.
        if let stretch, stretch.top <= band.lowerBound,
            stretch.top + stretch.lines.height >= band.upperBound
        {
            return stretch.lines.paint(rect, top: blockTop + stretch.top, with: painter)
        }
        guard let host else { return nil }
        let text = storage.string as NSString
        let (location, length) = (range.location, CGFloat(range.length))
        let units = { (y: CGFloat) in location + Int(y / self.height * length) }
        let from = text.noteLine(at: min(units(band.lowerBound), NSMaxRange(range) - 1))
            .location
        let reach = band.upperBound + painter.textView.bounds.height
        let to = min(NSMaxRange(text.noteLine(at: units(reach))), NSMaxRange(range))
        guard to > from,
            let lines = TextFirstLaidOutLines(
                storage, NSRange(location: from, length: to - from), width: width, host: host)
        else { return nil }
        stretch = (lines, estimate(from))
        return lines.paint(rect, top: blockTop + estimate(from), with: painter)
    }
}

/// UTF-16 `range` of a note's lines laid out in a TextKit stack of its own, with the line above
/// and the line below it for their spacing.
@MainActor
final class TextFirstLaidOutLines {
    let range: NSRange
    /// From its first line's top to the top of the line after it.
    let height: CGFloat
    private let manager: NSTextLayoutManager
    private let content: NSTextContentStorage
    /// Where `range` starts in the stack's text, and its first fragment's top there.
    private let start: Int
    private let top: CGFloat
    /// Retained: the stack holds its delegates weakly.
    private let layoutDelegate = TextFirstLayoutDelegate()
    private let breakDelegate = TextFirstImageBreakDelegate()

    init?(
        _ storage: NSTextStorage, _ range: NSRange, width: CGFloat,
        host: TextFirstEditorController
    ) {
        let text = storage.string as NSString
        let above =
            range.location > 0
            ? text.noteLine(at: range.location - 1) : NSRange(location: 0, length: 0)
        let below =
            NSMaxRange(range) < text.length
            ? text.noteLine(at: NSMaxRange(range)) : NSRange(location: text.length, length: 0)
        let whole = NSMutableAttributedString(
            attributedString: storage.attributedSubstring(
                from: NSRange(location: above.location, length: NSMaxRange(below) - above.location)
            ))
        content = NSTextContentStorage()
        content.delegate = breakDelegate
        manager = NSTextLayoutManager()
        layoutDelegate.host = host
        manager.delegate = layoutDelegate
        content.addTextLayoutManager(manager)
        let container = NSTextContainer(size: CGSize(width: width, height: 0))
        container.lineFragmentPadding = 0
        manager.textContainer = container
        content.textStorage?.setAttributedString(whole)
        manager.ensureLayout(for: manager.documentRange)
        start = range.location - above.location
        guard let first = Self.fragment(manager, content, at: start) else { return nil }
        top = first.layoutFragmentFrame.minY
        let foot: CGFloat
        if below.length > 0, let next = Self.fragment(manager, content, at: start + range.length) {
            foot = next.layoutFragmentFrame.minY
        } else {
            var last = first.layoutFragmentFrame.maxY
            manager.enumerateTextLayoutFragments(from: first.rangeInElement.location) {
                last = max(last, $0.layoutFragmentFrame.maxY)
                return true
            }
            foot = last
        }
        (self.range, height) = (range, foot - top)
    }

    private static func fragment(
        _ manager: NSTextLayoutManager, _ content: NSTextContentStorage, at offset: Int
    ) -> NSTextLayoutFragment? {
        content.location(content.documentRange.location, offsetBy: offset)
            .flatMap { manager.textLayoutFragment(for: $0) }
    }

    /// The top of the line holding the note's UTF-16 `offset`, below the first line's top.
    func y(ofLineAt offset: Int) -> CGFloat? {
        guard NSLocationInRange(offset, range),
            let f = Self.fragment(manager, content, at: start + offset - range.location)
        else { return nil }
        return f.layoutFragmentFrame.minY - top
    }

    /// `rect` (text view coordinates) as `painter` draws the note, the first line's top at
    /// `top`, over the surface colour.
    func paint(_ rect: CGRect, top at: CGFloat, with painter: TextFirstSlicePainter)
        -> CGImage?
    {
        let laidOut = painter.textView.textContainerInset.top + top
        let first = Self.fragment(manager, content, at: start)?.rangeInElement.location
        return painter.draw(
            rect, shift: at - laidOut,
            fragments: { visit in
                guard let first else { return }
                manager.enumerateTextLayoutFragments(from: first) { visit($0) }
            })
    }
}

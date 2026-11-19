import UIKit

// A lifted block laid out on its own, off screen (#449 review). The editor lays out only what
// is near the screen, and laying out text far above it moves what shows (TextKit settles its
// estimates). A block running beyond what is laid out, or carried away from its own place, is
// laid out a second time in its own TextKit stack instead, with the note's width, attributes
// and line breaking and the ends of its lines above and below for their spacing: that gives
// its height and draws any stretch of it for the copy in the gap. A block of up to `whole`
// UTF-16 units is laid out at once, its height exact; a longer one (a quote thousands of lines
// long) only its first stretch, its height estimated from it, and any other stretch the copy
// shows is laid out when it is drawn, as far as it takes to cover what is drawn.

@MainActor
final class TextFirstBlockLayout {
    /// The longest block laid out whole at the lift, in UTF-16 units: about 25 ms on the
    /// simulator (16,000 took 12 ms, 164,000 took 110 ms).
    static let whole = 40_000
    /// The block (UTF-16, in the note), and the width and the images' drawing
    /// (`drawingSignature`) it was laid out for.
    let range: NSRange
    let width: CGFloat
    let drawing: Int
    /// Its height, its top's y to its foot's (the next line's top), and whether that is
    /// measured (the block laid out whole) or estimated from its first stretch.
    let height: CGFloat
    let exact: Bool
    /// The block, or its first stretch, laid out; and the stretch the copy last needed.
    private let head: TextFirstLaidOutLines
    private var stretch: (lines: TextFirstLaidOutLines, top: CGFloat)?
    private let storage: NSTextStorage
    private let context: TextFirstLaidOutLines.Context
    private let toEnd: Bool

    /// `block` of `storage` laid out `width` wide, drawn as the editor `host` draws it: a table
    /// scrolled as it is there, the note's empty last line's block (and nothing that reads the
    /// editor's selection or Find, whose offsets are the note's).
    /// A block running to the note's end (`toEnd`, as the engine says) takes the note's empty
    /// last line (an empty task) with it, its row and its box; one ending above it does not.
    init?(
        _ storage: NSTextStorage, block: NSRange, width: CGFloat, drawing: Int,
        host: TextFirstEditorController, toEnd: Bool = false
    ) {
        let text = storage.string as NSString
        context = (
            { [weak host] start in host?.tableScroll[start] ?? 0 }, host.trailingBlock
        )
        var first = block
        if block.length > Self.whole {
            let end = NSMaxRange(text.noteLine(at: block.location + Self.whole))
            first.length = min(end, NSMaxRange(block)) - block.location
        }
        self.toEnd = toEnd
        guard
            let head = TextFirstLaidOutLines(
                storage, first, width: width, context, toEnd: toEnd && first == block)
        else {
            return nil
        }
        (self.head, self.storage) = (head, storage)
        (range, self.width, self.drawing) = (block, width, drawing)
        exact = first.length == block.length
        height = exact ? head.height : head.height * CGFloat(block.length) / CGFloat(first.length)
    }

    /// The top of the line holding the note's UTF-16 `offset`, below the block's top; nil
    /// outside the block. Beyond the first stretch of a long block, where the estimate puts
    /// it.
    func y(ofLineAt offset: Int) -> CGFloat? {
        guard NSLocationInRange(offset, range) else { return nil }
        if NSLocationInRange(offset, head.range) { return head.y(ofLineAt: offset) }
        return estimate((storage.string as NSString).noteLine(at: offset).location)
    }

    private func estimate(_ offset: Int) -> CGFloat {
        height * CGFloat(offset - range.location) / CGFloat(max(1, range.length))
    }

    /// `rect` (text view coordinates) as `painter` draws the note, the block's top at
    /// `blockTop`, over the surface colour; nil when what is laid out of the block does not
    /// cover it.
    func paint(_ rect: CGRect, blockTop: CGFloat, with painter: TextFirstSlicePainter)
        -> CGImage?
    {
        let band = (rect.minY - blockTop)...(rect.maxY - blockTop)
        if exact || band.upperBound <= head.height + 1 {
            return head.paint(rect, top: blockTop, with: painter)
        }
        if let stretch, stretch.top <= band.lowerBound,
            stretch.top + stretch.lines.height >= band.upperBound
        {
            return stretch.lines.paint(rect, top: blockTop + stretch.top, with: painter)
        }
        // Beyond the first stretch: from the line the estimate puts at the band's top, as many
        // lines as it takes to cover the band, laid out when first drawn.
        let text = storage.string as NSString
        let (location, end) = (range.location, NSMaxRange(range))
        let units = { (y: CGFloat) in location + Int(y / self.height * CGFloat(self.range.length)) }
        let from = text.noteLine(at: min(max(units(band.lowerBound), location), end - 1)).location
        var reach = band.upperBound + painter.textView.bounds.height
        for _ in 0..<8 {
            let to = min(NSMaxRange(text.noteLine(at: min(units(reach), end - 1))), end)
            guard to > from,
                let lines = TextFirstLaidOutLines(
                    storage, NSRange(location: from, length: to - from), width: width, context,
                    toEnd: toEnd && to == end)
            else { return nil }
            let top = estimate(from)
            if top + lines.height >= band.upperBound || to == end {
                guard top + lines.height >= band.upperBound else { return nil }
                stretch = (lines, top)
                return lines.paint(rect, top: blockTop + top, with: painter)
            }
            reach += 2 * (band.upperBound - top - lines.height) + painter.textView.bounds.height
        }
        return nil
    }
}

/// UTF-16 `range` of a note's lines laid out in a TextKit stack of its own, with the ends of
/// the line above and the line below it for their spacing. An empty range at the note's end
/// is its empty last line (an empty task): the row its block is drawn on.
@MainActor
final class TextFirstLaidOutLines {
    /// What the stack reads of the editor (`TextFirstLayoutFragment.detached`).
    typealias Context = (
        tableScroll: @MainActor (Int) -> CGFloat, trailing: TextFirstBlockAttribute?
    )
    /// How much of a neighbouring line is copied for its spacing, in UTF-16 units.
    private static let neighbour = 512
    let range: NSRange
    /// From its first line's top to the top of the line after it.
    let height: CGFloat
    private let manager: NSTextLayoutManager
    private let content: NSTextContentStorage
    /// Where `range` starts in the stack's text, and its first row's top there.
    private let start: Int
    private let top: CGFloat
    /// Retained: the stack holds its delegates weakly.
    private let layoutDelegate = TextFirstLayoutDelegate()
    private let breakDelegate = TextFirstImageBreakDelegate()

    /// `toEnd`: the lines run to the note's end, its empty last line (an empty task) included.
    init?(
        _ storage: NSTextStorage, _ range: NSRange, width: CGFloat, _ context: Context,
        toEnd: Bool = false
    ) {
        let text = storage.string as NSString
        var above =
            range.location > 0
            ? text.noteLine(at: range.location - 1) : NSRange(location: 0, length: 0)
        var below =
            NSMaxRange(range) < text.length
            ? text.noteLine(at: NSMaxRange(range)) : NSRange(location: text.length, length: 0)
        // Only the ends of a long neighbour: its spacing is its paragraph's, whatever its text.
        if above.length > Self.neighbour, range.length > 0 {
            let from = text.rangeOfComposedCharacterSequence(
                at: NSMaxRange(above) - Self.neighbour
            ).location
            above = NSRange(location: from, length: NSMaxRange(above) - from)
        }
        if below.length > Self.neighbour {
            let to = NSMaxRange(
                text.rangeOfComposedCharacterSequence(at: below.location + Self.neighbour))
            below.length = to - below.location
        }
        let whole = NSMutableAttributedString(
            attributedString: storage.attributedSubstring(
                from: NSRange(location: above.location, length: NSMaxRange(below) - above.location)
            ))
        content = NSTextContentStorage()
        content.delegate = breakDelegate
        manager = NSTextLayoutManager()
        // The note's empty last line (an empty task) is drawn with lines that run to the
        // note's end; lines that end above it end at its top, as the note's boundary does.
        let trailing = range.length == 0 || toEnd
        layoutDelegate.detached = (context.tableScroll, trailing ? context.trailing : nil)
        manager.delegate = layoutDelegate
        content.addTextLayoutManager(manager)
        let container = NSTextContainer(size: CGSize(width: width, height: 0))
        container.lineFragmentPadding = 0
        manager.textContainer = container
        content.textStorage?.setAttributedString(whole)
        manager.ensureLayout(for: manager.documentRange)
        start = range.location - above.location
        self.range = range
        if range.length == 0 {
            // The empty last line: the row the last fragment draws its block on.
            guard
                let last = Self.fragment(manager, content, at: max(0, start - 1))
                    as? TextFirstLayoutFragment,
                let row = last.trailingRowFrame
            else { return nil }
            (top, height) = (last.layoutFragmentFrame.minY + row.top, row.height)
            return
        }
        guard let first = Self.fragment(manager, content, at: start) else { return nil }
        top = first.layoutFragmentFrame.minY
        // The line after it (several fragments may make one line: a lone return or U+2029
        // starts a TextKit paragraph inside it); else the last fragment's foot.
        if below.length > 0, let next = Self.fragment(manager, content, at: start + range.length) {
            height = next.layoutFragmentFrame.minY - top
        } else {
            var last = first.layoutFragmentFrame.maxY
            manager.enumerateTextLayoutFragments(from: first.rangeInElement.location) {
                last = max(last, $0.layoutFragmentFrame.maxY)
                if let row = ($0 as? TextFirstLayoutFragment)?.trailingRowFrame {
                    last = $0.layoutFragmentFrame.minY + row.top + (trailing ? row.height : 0)
                }
                return true
            }
            height = last - top
        }
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

    /// `rect` (text view coordinates) as `painter` draws the note, the first row's top at
    /// `top`, over the surface colour.
    func paint(_ rect: CGRect, top at: CGFloat, with painter: TextFirstSlicePainter)
        -> CGImage?
    {
        let laidOut = painter.textView.textContainerInset.top + top
        let first = Self.fragment(
            manager, content, at: max(0, range.length == 0 ? start - 1 : start))?
            .rangeInElement.location
        return painter.draw(
            rect, shift: at - laidOut,
            fragments: { visit in
                guard let first else { return }
                manager.enumerateTextLayoutFragments(from: first) { visit($0) }
            })
    }
}

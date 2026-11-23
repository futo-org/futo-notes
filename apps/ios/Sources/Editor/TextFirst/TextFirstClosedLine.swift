import UIKit

// A photo lifted out of a line of text (`Nice!![](a.jpg)`) leaves that line to be laid out
// again without it: the words close up, and may wrap differently. The live preview cannot get
// that by sliding slices, so the line is laid out a second time off screen, in its own TextKit
// stack with the note's width, attributes and line breaking, the photo's characters left out.
// That gives the line's closed height and its drawing. The photo is laid out there too as the
// line of its own it becomes, at the text's margin and its own height, which is what the copy
// in a gap shows. It costs one paragraph's layout at the lift. The real lines, laid out by the
// move at the drop, replace both under the preview.

@MainActor
final class TextFirstClosedLine {
    /// The line's height laid out without the photo, the photo's own line's height, and the
    /// width and the note's drawing (`TextFirstReflowPlan.drawing`) they were laid out for.
    let height: CGFloat
    let photoHeight: CGFloat
    let width: CGFloat
    let drawing: Int
    private let photoFragments: [NSTextLayoutFragment]
    private let manager: NSTextLayoutManager
    private let content: NSTextContentStorage
    /// The fragments of the line without the photo: TextKit starts a paragraph inside a
    /// note's line at a lone return or U+2029, so one line can be several.
    private let fragments: [NSTextLayoutFragment]
    /// Retained: the stack holds its delegates weakly.
    private let layoutDelegate = TextFirstLayoutDelegate()
    private let typesetDelegate = TextFirstTypesetDelegate()

    /// The display line `line` (UTF-16, its line ending included when it has one) of `storage`
    /// without `photo`, and `photo` as a line of its own, laid out `width` wide. Nil when
    /// TextKit gives either no fragment.
    init?(
        _ storage: NSTextStorage, line: NSRange, removing photo: NSRange, width: CGFloat,
        drawing: Int
    ) {
        // The photo must lie inside the line: a mismatch (lines counted another way) gives
        // no closed line, and the drag shows the drop line, rather than an out-of-range edit.
        guard photo.location >= line.location, NSMaxRange(photo) <= NSMaxRange(line),
            NSMaxRange(line) <= storage.length
        else { return nil }
        let text = NSMutableAttributedString(
            attributedString: storage.attributedSubstring(from: line))
        text.deleteCharacters(
            in: NSRange(location: photo.location - line.location, length: photo.length))
        // Compared as UTF-16: a CRLF ending is one Character, so `hasSuffix("\n")` misses it.
        if (text.string as NSString).length == 0
            || (text.string as NSString).character(at: text.length - 1) != 0x0A
        {
            text.append(NSAttributedString(string: "\n", attributes: Self.plain))
        }
        // A line above and below it, so it is laid out as a line in the middle of a note: with
        // the spacing a line between others has, and no empty last line of its own.
        let whole = NSMutableAttributedString(string: "x\n", attributes: Self.plain)
        whole.append(text)
        let alone = whole.length
        whole.append(storage.attributedSubstring(from: photo))
        whole.append(NSAttributedString(string: "\nx", attributes: Self.plain))
        content = NSTextContentStorage()
        content.delegate = typesetDelegate
        manager = NSTextLayoutManager()
        manager.delegate = layoutDelegate
        content.addTextLayoutManager(manager)
        let container = NSTextContainer(size: CGSize(width: width, height: 0))
        container.lineFragmentPadding = 0
        manager.textContainer = container
        content.textStorage?.setAttributedString(whole)
        manager.ensureLayout(for: manager.documentRange)
        // Each is measured from its first fragment's top to the next one's first.
        let (laid, stack) = (manager, content)
        func fragments(_ from: Int, _ to: Int) -> [NSTextLayoutFragment] {
            let begin = stack.documentRange.location
            guard let at = stack.location(begin, offsetBy: from) else { return [] }
            var found: [NSTextLayoutFragment] = []
            laid.enumerateTextLayoutFragments(from: at) { f in
                guard laid.offset(from: begin, to: f.rangeInElement.location) < to else {
                    return false
                }
                found.append(f)
                return true
            }
            return found
        }
        let sentinel = whole.length - 1
        let closed = fragments(2, alone)
        let photo = fragments(alone, sentinel)
        guard let first = closed.first, let photoFirst = photo.first,
            let foot = fragments(sentinel, whole.length).first
        else { return nil }
        (self.fragments, photoFragments) = (closed, photo)
        height = photoFirst.layoutFragmentFrame.minY - first.layoutFragmentFrame.minY
        photoHeight = foot.layoutFragmentFrame.minY - photoFirst.layoutFragmentFrame.minY
        (self.width, self.drawing) = (width, drawing)
    }

    private static var plain: [NSAttributedString.Key: Any] {
        TextFirstEditorController.baseAttributes
    }

    /// The stretch `band` of the closed line (its own coordinates, 0 at its top) as `painter`
    /// draws the note with the line's top at `top` (text view coordinates: it keeps the place
    /// it has with the photo), over the surface colour.
    func paint(
        _ band: ClosedRange<CGFloat>, at top: CGFloat, with painter: TextFirstSlicePainter
    ) -> CGImage? {
        let laidOut =
            painter.textView.textContainerInset.top + fragments[0].layoutFragmentFrame.minY
        return painter.draw(
            CGRect(
                x: 0, y: top + band.lowerBound, width: painter.textView.bounds.width,
                height: band.upperBound - band.lowerBound),
            shift: top - laidOut,
            fragments: { visit in for f in fragments where !visit(f) { break } })
    }

    /// The stretch `band` (its own coordinates, 0 at its top) of the photo's own line, its top
    /// at `top` (text view coordinates), as `painter` draws the note, over the surface colour.
    func paintPhoto(
        _ band: ClosedRange<CGFloat>, at top: CGFloat, with painter: TextFirstSlicePainter
    ) -> CGImage? {
        let laidOut =
            painter.textView.textContainerInset.top + photoFragments[0].layoutFragmentFrame.minY
        let from = painter.pixel(top + band.lowerBound)
        return painter.draw(
            CGRect(
                x: 0, y: from, width: painter.textView.bounds.width,
                height: painter.pixel(top + band.upperBound) - from),
            shift: top - laidOut,
            fragments: { visit in for f in photoFragments where !visit(f) { break } })
    }
}

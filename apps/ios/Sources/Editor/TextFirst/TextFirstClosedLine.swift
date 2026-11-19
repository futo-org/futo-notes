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
    private let photoFragment: NSTextLayoutFragment
    private let manager: NSTextLayoutManager
    private let content: NSTextContentStorage
    private let fragment: NSTextLayoutFragment
    /// Retained: the stack holds its delegates weakly.
    private let layoutDelegate = TextFirstLayoutDelegate()
    private let breakDelegate = TextFirstImageBreakDelegate()

    /// The display line `line` (UTF-16, its line ending included when it has one) of `storage`
    /// without `photo`, and `photo` as a line of its own, laid out `width` wide. Nil when
    /// TextKit gives either no fragment.
    init?(
        _ storage: NSTextStorage, line: NSRange, removing photo: NSRange, width: CGFloat,
        drawing: Int
    ) {
        let text = NSMutableAttributedString(
            attributedString: storage.attributedSubstring(from: line))
        text.deleteCharacters(
            in: NSRange(location: photo.location - line.location, length: photo.length))
        if !text.string.hasSuffix("\n") {
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
        content.delegate = breakDelegate
        manager = NSTextLayoutManager()
        manager.delegate = layoutDelegate
        content.addTextLayoutManager(manager)
        let container = NSTextContainer(size: CGSize(width: width, height: 0))
        container.lineFragmentPadding = 0
        manager.textContainer = container
        content.textStorage?.setAttributedString(whole)
        manager.ensureLayout(for: manager.documentRange)
        guard let at = content.location(content.documentRange.location, offsetBy: 2),
            let fragment = manager.textLayoutFragment(for: at),
            let photoAt = content.location(content.documentRange.location, offsetBy: alone),
            let photoFragment = manager.textLayoutFragment(for: photoAt)
        else { return nil }
        (self.fragment, self.photoFragment) = (fragment, photoFragment)
        (height, photoHeight) = (
            fragment.layoutFragmentFrame.height, photoFragment.layoutFragmentFrame.height
        )
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
        let laidOut = painter.textView.textContainerInset.top + fragment.layoutFragmentFrame.minY
        return painter.draw(
            CGRect(
                x: 0, y: top + band.lowerBound, width: painter.textView.bounds.width,
                height: band.upperBound - band.lowerBound),
            shift: top - laidOut, fragments: { visit in _ = visit(fragment) })
    }

    /// The photo's own line, its top at `top` (text view coordinates), as `painter` draws the
    /// note, over the surface colour.
    func paintPhoto(at top: CGFloat, with painter: TextFirstSlicePainter) -> CGImage? {
        let laidOut =
            painter.textView.textContainerInset.top + photoFragment.layoutFragmentFrame.minY
        return painter.draw(
            CGRect(x: 0, y: top, width: painter.textView.bounds.width, height: photoHeight),
            shift: top - laidOut, fragments: { visit in _ = visit(photoFragment) })
    }
}

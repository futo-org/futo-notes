import UIKit

// UIKit tints a selection's middle rows from the text container's edge. On a list row the indent
// before the marker is not text: a row is tinted from its first character, the marker unit when
// the selection holds it, else the item's text (a wrapped row from where its text starts), and
// a right-to-left row the same from its right.

extension TextFirstEditorController {
    /// `rects` (text view coordinates) of `selection`, each list row's part starting at the
    /// row's first selected character.
    func listRowSelectionRects(_ rects: [UITextSelectionRect], of selection: NSRange)
        -> [UITextSelectionRect]
    {
        guard let manager = textView.textLayoutManager else { return rects }
        return rects.flatMap { rect -> [UITextSelectionRect] in
            let rows = visualRows(in: rect.rect, from: selection.location, manager)
            guard rows.contains(where: \.isList) else { return [rect] }
            return rows.compactMap { row in
                var frame = rect.rect.intersection(
                    CGRect(
                        x: rect.rect.minX, y: row.top, width: rect.rect.width, height: row.height))
                guard !frame.isNull, frame.height > 0 else { return nil }
                if row.isList {
                    let left = row.rightToLeft ? frame.minX : max(frame.minX, row.start)
                    let right = row.rightToLeft ? min(frame.maxX, row.start) : frame.maxX
                    guard right > left else { return nil }
                    frame = CGRect(
                        x: left, y: frame.minY, width: right - left, height: frame.height)
                }
                return frame == rect.rect ? rect : TextFirstSelectionRect(rect, drawnAs: frame)
            }
        }
    }

    /// Each laid-out row the rect covers at its middle: its vertical span, whether it is a list
    /// line's, and the leading edge of its first character at or after `selectionStart`.
    private func visualRows(
        in rect: CGRect, from selectionStart: Int, _ manager: NSTextLayoutManager
    )
        -> [(top: CGFloat, height: CGFloat, isList: Bool, start: CGFloat, rightToLeft: Bool)]
    {
        var rows: [(CGFloat, CGFloat, Bool, CGFloat, Bool)] = []
        guard
            let from = manager.textLayoutFragment(
                for: CGPoint(x: 0, y: max(0, rect.minY - inset.top + 0.5)))
        else { return [] }
        manager.enumerateTextLayoutFragments(from: from.rangeInElement.location, options: []) {
            fragment in
            let frame = fragment.layoutFragmentFrame
            if inset.top + frame.minY >= rect.maxY { return false }
            let isList = (fragment as? TextFirstLayoutFragment)?.block.list != nil
            let paragraphStart = manager.offset(
                from: manager.documentRange.location, to: fragment.rangeInElement.location)
            for line in fragment.textLineFragments where line.characterRange.length > 0 {
                let bounds = line.typographicBounds
                let top = inset.top + frame.minY + bounds.minY
                guard rect.minY <= top + bounds.height / 2, top + bounds.height / 2 < rect.maxY
                else { continue }
                let first = min(
                    max(line.characterRange.location, selectionStart - paragraphStart),
                    NSMaxRange(line.characterRange) - 1)
                let edge = line.locationForCharacter(at: first).x
                let next =
                    line.characterRange.length > 1
                    ? line.locationForCharacter(at: first + 1).x : edge
                rows.append(
                    (
                        top, bounds.height, isList, inset.left + frame.minX + bounds.minX + edge,
                        next < edge
                    ))
            }
            return true
        }
        return rows
    }
}

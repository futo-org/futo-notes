import UIKit

// UIKit tints a selection's middle rows from the text container's edge. On a list row the indent
// before the marker is not text: a row is tinted from its first character, the marker unit when
// the selection holds it, else the item's text (a wrapped row from where its text starts), and
// a right-to-left row the same from its right.

/// One laid-out row a selection rect crosses: its span, whether it is a list line's, where its
/// tint may start, and whether it holds the selection's start or end.
struct ListSelectionRow {
    let top: CGFloat
    let height: CGFloat
    let isList: Bool
    let start: CGFloat
    let rightToLeft: Bool
    let holdsStart: Bool
    let holdsEnd: Bool
}

extension TextFirstEditorController {
    /// `rects` (text view coordinates) of `selection`, each list row's part starting at the
    /// row's first selected character.
    func listRowSelectionRects(_ rects: [UITextSelectionRect], of selection: NSRange)
        -> [UITextSelectionRect]
    {
        guard selection.length > 0, let manager = textView.textLayoutManager else { return rects }
        return rects.flatMap { rect -> [UITextSelectionRect] in
            let rows = visualRows(in: rect.rect, of: selection, manager)
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
                // A piece keeps an end's handle only on the row that holds that end.
                let start = rect.containsStart && row.holdsStart
                let end = rect.containsEnd && row.holdsEnd
                if frame == rect.rect, start == rect.containsStart, end == rect.containsEnd {
                    return rect
                }
                return TextFirstSelectionRect(
                    rect, drawnAs: frame, containsStart: start, containsEnd: end)
            }
        }
    }

    /// Each laid-out row the rect covers at its middle: its vertical span, whether it is a list
    /// line's, and the leading edge of its first character at or after `selectionStart`. Only
    /// the viewport's laid-out rows are read: laying out text elsewhere would re-base TextKit's
    /// height estimate under the reader, and a row off screen is not drawn.
    private func visualRows(
        in rect: CGRect, of selection: NSRange, _ manager: NSTextLayoutManager
    ) -> [ListSelectionRow] {
        let selectionStart = selection.location
        var rows: [ListSelectionRow] = []
        guard let shown = manager.textViewportLayoutController.viewportRange else { return [] }
        manager.enumerateTextLayoutFragments(from: shown.location, options: []) { fragment in
            let frame = fragment.layoutFragmentFrame
            if inset.top + frame.minY >= rect.maxY
                || fragment.rangeInElement.location.compare(shown.endLocation) != .orderedAscending
            {
                return false
            }
            if inset.top + frame.maxY <= rect.minY { return true }
            let isList = (fragment as? TextFirstLayoutFragment)?.block.list != nil
            let paragraphStart = manager.offset(
                from: manager.documentRange.location, to: fragment.rangeInElement.location)
            for line in fragment.textLineFragments where line.characterRange.length > 0 {
                let bounds = line.typographicBounds
                let top = inset.top + frame.minY + bounds.minY
                guard rect.minY <= top + bounds.height / 2, top + bounds.height / 2 < rect.maxY
                else { continue }
                // The row's direction is its paragraph's (an item's marker unit says it), and
                // its edge is where its text leads; the selection's start moves the edge only
                // when that character runs the row's way (from inside a right-to-left run of a
                // left-to-right row, the rest of the row stays tinted).
                let range = line.characterRange
                func x(_ i: Int) -> CGFloat { line.locationForCharacter(at: i).x }
                let rightToLeft =
                    (fragment as? TextFirstLayoutFragment)?.markerUnit?.rightToLeft
                    ?? (range.length > 1 && x(range.location + 1) < x(range.location))
                var edge = x(range.location)
                let start = selectionStart - paragraphStart
                if start > range.location, start < NSMaxRange(range) - 1,
                    (x(start + 1) < x(start)) == rightToLeft
                {
                    edge = x(start)
                }
                let lineStart = paragraphStart + range.location
                let lineEnd = paragraphStart + NSMaxRange(range)
                rows.append(
                    ListSelectionRow(
                        top: top, height: bounds.height, isList: isList,
                        start: inset.left + frame.minX + bounds.minX + edge,
                        rightToLeft: rightToLeft,
                        holdsStart: lineStart <= selection.location
                            && selection.location < max(lineEnd, lineStart + 1),
                        holdsEnd: lineStart < NSMaxRange(selection)
                            && NSMaxRange(selection) <= lineEnd))
            }
            return true
        }
        return rows
    }
}

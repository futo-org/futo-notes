import UIKit

// The copy of the lifted block a live preview draws in the gap (#448, #449): only the stretch of
// it that can show, from the note while that part of the block is laid out where the plan says
// it is, else from the block laid out on its own; a photo lifted out of a line as the line of
// its own it becomes.

extension TextFirstReflow {
    /// The stretch of a copy `height` tall that shows with the gap at `gap`: the part that
    /// shows there and a quarter screen around it (all of one that fits), so nothing far off
    /// screen is laid out or drawn for it.
    func window(for gap: Int, height: CGFloat) -> ClosedRange<CGFloat> {
        let top = plan.copy(gap).minY
        let from = min(max(0, visible.minY - visible.height / 4 - top), height)
        let to = min(height, visible.maxY + visible.height / 4 - top)
        return from...max(from, to)
    }

    /// Draw the copy's stretch for `gap`: from the note while that part of the block is laid
    /// out where the plan measured it, else from the block laid out on its own. A photo lifted
    /// out of a line is drawn as its own line instead (`drawAway`), never from where its line
    /// was.
    func drawCopy(for gap: Int) {
        if closedLine != nil, plan.closing == nil { return }
        let needed = window(for: gap, height: plan.source.height)
        if let drawn = copyImage?.window, drawn.contains(needed.lowerBound),
            drawn.contains(needed.upperBound)
        {
            return
        }
        let source = plan.source
        let top = painter.pixel(source.minY + needed.lowerBound)
        let rect = CGRect(
            x: source.minX, y: top, width: source.width,
            height: painter.pixel(source.minY + needed.upperBound) - top)
        let anchor = plan.closing?.anchor ?? plan.sourceAnchor
        let inNote = plan.sourceLaidOut.map { $0 ~= rect.minY && $0 ~= rect.maxY - 0.5 } ?? false
        let drawn = inNote ? painter.paint(rect, from: anchor) : drawBlock?(rect, source.minY)
        guard let image = drawn else { return }
        copyImage = (image, needed, top - painter.pixel(source.minY))
        copy.contents = image
    }

    /// A photo lifted out of a line, as the line of its own it becomes, for the gap at `gap`:
    /// the stretch of it that shows there (a photo far taller than the screen is never drawn
    /// whole).
    func drawAway(for gap: Int)
        -> (image: CGImage, window: ClosedRange<CGFloat>, offset: CGFloat)?
    {
        guard let closedLine else { return nil }
        let needed = window(for: gap, height: closedLine.photoHeight)
        if let drawn = awayImage, drawn.window.contains(needed.lowerBound),
            drawn.window.contains(needed.upperBound)
        {
            return drawn
        }
        let top = plan.copy(gap).minY
        guard let image = closedLine.paintPhoto(needed, at: top, with: painter) else { return nil }
        awayImage = (image, needed, painter.pixel(top + needed.lowerBound) - painter.pixel(top))
        return awayImage
    }
}

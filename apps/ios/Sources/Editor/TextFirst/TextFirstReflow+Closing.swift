import UIKit

// The line a photo is lifted out of, as a live preview draws it closed up (#448, #449): each run
// of it drawn from the line laid out again without the photo, only a screen's band around what
// shows of it where the run is drawn now, drawn again when the gap moves it past that band.

extension TextFirstReflow {
    /// The part of a photo's line run `j` is once the photo has left; its home drawing, as
    /// far below its top as that drawing starts, for a run outside that line.
    func closedDrawing(_ j: Int, at top: CGFloat) -> (CGImage?, CGFloat) {
        let run = plan.runs[j]
        guard let closedLine, let line = plan.closing, closes(j)
        else { return (slices[j].home, slices[j].offset) }
        // Only a screen's band around what shows of it, drawn with its top at `top` (a row
        // beside a photo far taller than the screen stays as tall), as far below its top.
        let from = line.closedY(run.top - line.top)
        let shown = max(0, visible.minY - visible.height / 2 - top)
        let to = min(run.closed, visible.maxY + visible.height / 2 - top)
        guard to > shown else { return (nil, 0) }
        let image = closedLine.paint(
            (from + shown)...(from + to), at: line.top, with: painter)
        return (image, painter.pixel(line.top + from + shown) - painter.pixel(line.top + from))
    }

    /// Whether run `j` is part of the line a photo is lifted out of.
    func closes(_ j: Int) -> Bool {
        guard closedLine != nil, let line = plan.closing else { return false }
        return plan.runs[j].top >= line.top - 0.5 && plan.runs[j].bottom <= line.bottom + 0.5
    }

    /// Where run `j` is drawn closed now: with the gap open, or, at home, as any gap would.
    func closedAt(_ j: Int) -> CGFloat {
        gap == plan.home ? plan.closedTop(j) : plan.top(j, gap: gap)
    }

    /// Run `j`'s closed drawing for where it is drawn now, drawn again when the gap has moved
    /// it so that what shows of it is beyond the band drawn.
    func closedFits(_ j: Int) {
        guard closes(j) else { return }
        let top = closedAt(j)
        let needed = max(0, visible.minY - top)...max(0, visible.maxY - top)
        let height = slices[j].closed.map { CGFloat($0.height) / painter.scale } ?? 0
        let drawn = slices[j].closedOffset...(slices[j].closedOffset + height)
        let run = plan.runs[j]
        guard needed.lowerBound < run.closed, needed.upperBound > 0,
            !(drawn.contains(needed.lowerBound)
                && drawn.contains(min(needed.upperBound, run.closed)))
        else { return }
        (slices[j].closed, slices[j].closedOffset) = closedDrawing(j, at: top)
    }
}

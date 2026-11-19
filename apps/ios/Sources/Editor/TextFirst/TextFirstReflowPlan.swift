import CoreGraphics
import Foundation

// Where a block drag's live preview (#448) draws each part of the note for each gap. The note
// on screen is cut into runs at the engine's slots and the block's own edges; a run is drawn
// as one slice and only ever moves whole. Runs are known by the text they start at, never by
// where they were drawn, so a run keeps its identity when the layout changes or (#449) when
// the note scrolls. Everything here is arithmetic on positions read from TextKit's layout.

/// The runs of the note around a lifted block, where each is drawn for a gap, and the gap a
/// finger chooses.
struct TextFirstReflowPlan: Equatable {
    /// A stretch of the note drawn as one slice: from one cut to the next.
    struct Run: Equatable {
        /// The boundary its top is measured from (a line's start, or the note's end) and how
        /// far below that its top is (zero at a slot or the block's edge; a run cut by the
        /// screen's edge starts inside a line).
        let anchor: TextFirstBlockSlot
        let inset: CGFloat
        /// Where it is laid out at home (text view coordinates) and how tall it is there.
        var top: CGFloat
        var height: CGFloat
        /// How tall it is once the block has left its place: smaller only for the parts of the
        /// line a photo is lifted out of, which closes up without it.
        var closed: CGFloat
        /// What the images in it draw (`drawing` below, for this run's text).
        var drawing: Int
        var bottom: CGFloat { top + height }
    }

    /// In display order, top to bottom, without the block.
    var runs: [Run]
    /// The boundary the block sits on: a gap there moves nothing. Boundary `i` is the top of
    /// `runs[i]`, or the bottom of the last run for `runs.count`. When the block's place does
    /// not show (`homeShown` false) home is beyond the runs on its side (-1, or one past
    /// `runs.count`): no boundary, and no place the gap may open.
    let home: Int
    let homeShown: Bool
    /// The engine's slot at each boundary the block may land on.
    let slots: [Int: TextFirstBlockSlot]
    /// The block where it is drawn (text view coordinates): its band of the note, or the photo.
    let source: CGRect
    /// The height the block takes in a gap, and the height its leaving takes out of its place
    /// (none for a photo lifted out of a line: that line closes up instead).
    let room: CGFloat
    let left: CGFloat
    /// How the copy is drawn in a gap (its x, width and height): the block as it is, or for a
    /// photo lifted out of a line, the photo's own line.
    let away: CGRect
    /// What the images of a photo's line draw (each one's place, size and whether it has
    /// decoded): a change lays the line out again without the photo. Zero for other blocks.
    let drawing: Int
    /// What the images of the block itself draw: a change draws its copy again.
    let blockDrawing: Int
    /// Whether `room` is the block's measured height (both its edges read, or it laid out
    /// whole apart), not an estimate.
    let exact: Bool
    /// The UTF-16 start of the line the block's drawing starts on.
    let sourceAnchor: Int
    /// The part of `source` TextKit has laid out (text view coordinates), where the copy can
    /// be drawn from the note itself; nil when none is.
    let sourceLaidOut: ClosedRange<CGFloat>?
    /// The line a photo is lifted out of, which closes up without it; nil for any other block.
    let closing: Closing?

    /// A photo's line, laid out at home with the photo and once more without it.
    struct Closing: Equatable {
        /// Its band at home (text view coordinates) and the UTF-16 start of the line.
        let top: CGFloat
        let bottom: CGFloat
        let anchor: Int
        /// In the line's own coordinates (0 at its top): where the photo's row starts and ends,
        /// where home cuts the line (the photo's middle), and its height without the photo.
        let photoTop: CGFloat
        let rowBottom: CGFloat
        let home: CGFloat
        let closed: CGFloat

        /// Where `y` (the line's own coordinates, as laid out with the photo) is in the line
        /// laid out without it: above the photo it stays, the photo's row closes to nothing,
        /// and below it moves up by that row.
        func closedY(_ y: CGFloat) -> CGFloat {
            let cut = min(photoTop, closed)
            if y <= home { return min(y, cut) }
            if y >= bottom - top - 0.5 { return closed }
            return min(closed, cut + max(0, y - rowBottom))
        }
    }

    /// The boundaries the gap may open on, in order: the slots and home.
    var positions: [Int] { (Array(slots.keys) + (homeShown ? [home] : [])).sorted() }

    /// All the block's leaving takes out of the note: its place, or what the line a photo is
    /// lifted out of closes up by.
    var leaves: CGFloat { left + (closing.map { $0.bottom - $0.top - $0.closed } ?? 0) }

    /// How much taller than the note the preview draws it with the gap at `gap`: the block's
    /// room in the gap beyond what its leaving takes out (a photo lifted out of a row it
    /// shared takes a line of its own). The note may scroll that far past its end.
    func grows(_ gap: Int) -> CGFloat {
        guard gap != home else { return 0 }
        return max(0, room - leaves)
    }

    /// The slot a release with the gap at `gap` lands on; nil at home.
    func slot(_ gap: Int) -> TextFirstBlockSlot? { gap == home ? nil : slots[gap] }

    /// The boundary of `slot`, if it is one of the plan's.
    func boundary(of slot: TextFirstBlockSlot) -> Int? {
        slots.first { $0.value == slot }?.key
    }

    /// How tall run `j` is drawn with the gap at `gap`.
    func height(_ j: Int, gap: Int) -> CGFloat { gap == home ? runs[j].height : runs[j].closed }

    /// Where run `j`'s top is drawn with the gap at `gap` (as laid out, before pixel rounding):
    /// below the gap it is pushed down by the block's room, below home it is pulled up by what
    /// the block's leaving takes out, and below a line that closed up it moves up with it.
    func top(_ j: Int, gap: Int) -> CGFloat {
        guard gap != home else { return runs[j].top }
        var y = runs[j].top + (j >= gap ? room : 0) - (j >= home ? left : 0)
        for i in 0..<j { y += runs[i].closed - runs[i].height }
        return y
    }

    /// Where run `j`'s top is drawn with any gap open but above it (as `top(_:gap:)`): every
    /// gap draws it there, or a block's room lower.
    func closedTop(_ j: Int) -> CGFloat {
        var y = runs[j].top - (j >= home ? left : 0)
        for i in 0..<j { y += runs[i].closed - runs[i].height }
        return y
    }

    /// Where the copy of the block is drawn with the gap at `gap`: at home, in place; elsewhere
    /// the top of the gap, the room above the run below it, as wide and as far in as `away`.
    func copy(_ gap: Int) -> CGRect {
        guard gap != home, !runs.isEmpty else { return source }
        let y =
            gap < runs.count
            ? top(gap, gap: gap) - room
            : top(runs.count - 1, gap: gap) + height(runs.count - 1, gap: gap)
        return CGRect(x: away.minX, y: y, width: away.width, height: away.height)
    }

    /// The gap a finger at `y` opens, starting from the gap open now (the web editor's
    /// `reflowGapAt`): the gap moves past the stretch of note between it and the next position
    /// it may open on once the finger passes that stretch's middle as it is drawn now, step by
    /// step, and stays put on the exact middle. Passing a stretch draws it on the gap's other
    /// side, so the finger has to come back past its middle as drawn there to undo the step,
    /// which is a block's height away: the gap does not flicker. `drawn` is each run's top as it
    /// is drawn now, mid-slide included; without it, where the gap at `start` puts it.
    func gap(from start: Int, finger y: CGFloat, drawn: [CGFloat]? = nil) -> Int {
        let drawn = drawn.flatMap { $0.count == runs.count ? $0 : nil }
        let positions = self.positions
        // A gap whose place is gone starts from the nearest place left.
        guard
            var gap = positions.contains(start)
                ? start : positions.min(by: { abs($0 - start) < abs($1 - start) })
        else { return home }
        // Each step passes one stretch, and a stretch passed is never passed back.
        for _ in 0...positions.count {
            guard let at = positions.firstIndex(of: gap) else { break }
            let next = at + 1 < positions.count ? positions[at + 1] : nil
            let previous = at > 0 ? positions[at - 1] : nil
            if let next, middle(gap..<next, gap: gap, drawn: drawn, start: start) < y {
                gap = next
            } else if let previous, middle(previous..<gap, gap: gap, drawn: drawn, start: start) > y
            {
                gap = positions[at - 1]
            } else {
                break
            }
        }
        return gap
    }

    /// The middle of runs `span`, which are drawn together: where they are drawn now
    /// (`drawn`, for the gap at `start`), else where the gap at `gap` puts them.
    private func middle(_ span: Range<Int>, gap: Int, drawn: [CGFloat]?, start: Int) -> CGFloat {
        guard let last = span.last else { return copy(gap).maxY }
        if let drawn {
            return (drawn[span.lowerBound] + drawn[last] + height(last, gap: start)) / 2
        }
        let top = top(span.lowerBound, gap: gap)
        return (top + self.top(last, gap: gap) + height(last, gap: gap)) / 2
    }
}

/// Where a display line of the note is after a block move, by index (the note's lines are what
/// a move rearranges; their UTF-16 offsets also shift when a line ending changes sides, as when
/// the last line moves). The block's lines `block` move to the boundary above line `slot` (the
/// line count for the note's end), every index as before the move. A photo lifted out of a line
/// (`photo`) leaves that line where it is and becomes a line of its own at the slot.
enum TextFirstMoveMap {
    static func line(_ k: Int, block: Range<Int>, to slot: Int, photo: Bool) -> Int {
        if photo { return k < slot ? k : k + 1 }
        let n = block.count
        if slot <= block.lowerBound {
            if k < slot || k >= block.upperBound { return k }
            return k < block.lowerBound ? k + n : slot + k - block.lowerBound
        }
        if k < block.lowerBound || k >= slot { return k }
        return k < block.upperBound ? slot - n + k - block.lowerBound : k - n
    }

    /// The index of the block's first line after the move.
    static func blockLine(_ block: Range<Int>, to slot: Int, photo: Bool) -> Int {
        photo || slot <= block.lowerBound ? slot : slot - block.count
    }
}

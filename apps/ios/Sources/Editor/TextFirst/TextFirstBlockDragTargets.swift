import UIKit

// Where a lifted block may land while the note scrolls under it (#443). The engine names the
// slots; the view keeps them by slot, never by where they were drawn at the lift, asks the
// engine only for the stretch of note that newly comes near the screen, and reads where each
// is drawn from TextKit's real layout every time the layout or the scroll changes
// (`TextFirstEditorController.dropTargets`). The edge autoscroll moves the note as the web
// editor's did.

/// The edge autoscroll of a block drag, as the web editor's (blockDragGeometry.ts): held within
/// 64 pt of the visible area's top or bottom edge the note scrolls, 200 pt/s at the zone's inner
/// lip ramping to 1400 pt/s at the edge (and past it), one frame's step capped at 0.05 s.
enum TextFirstAutoscroll {
    static let zone: CGFloat = 64
    static let slowest: CGFloat = 200
    static let fastest: CGFloat = 1400
    static let longestStep: TimeInterval = 0.05

    /// The note's scroll speed in points per second (negative scrolls up) for a finger at `y`
    /// in the visible span `shown`; zero outside the zones. Where the span is shorter than two
    /// zones the nearer edge wins.
    static func velocity(at y: CGFloat, in shown: ClosedRange<CGFloat>) -> CGFloat {
        let fromTop = y - shown.lowerBound
        let fromBottom = shown.upperBound - y
        func speed(_ distance: CGFloat) -> CGFloat {
            slowest + (fastest - slowest) * min(max((zone - distance) / zone, 0), 1)
        }
        if fromTop < zone && fromTop <= fromBottom { return -speed(fromTop) }
        if fromBottom < zone { return speed(fromBottom) }
        return 0
    }

    /// How far one frame scrolls at `velocity`, `elapsed` seconds after the last.
    static func step(_ velocity: CGFloat, elapsed: TimeInterval) -> CGFloat {
        velocity * CGFloat(min(max(elapsed, 0), longestStep))
    }
}

/// Runs the autoscroll once per frame while its velocity is not zero, the finger still or not.
/// The display link reaches it through a weak proxy: it stops when its drag goes away.
@MainActor
final class TextFirstAutoscroller {
    private var link: CADisplayLink?
    private var last: CFTimeInterval?
    private let scroll: (CGFloat) -> Bool

    /// `scroll` moves the note by a frame's step, false when it could not move at all (at an
    /// end of the note): the frames then rest until `resume`.
    init(_ scroll: @escaping (CGFloat) -> Bool) { self.scroll = scroll }

    var velocity: CGFloat = 0 {
        didSet {
            if velocity == 0 {
                stop()
            } else if link == nil {
                let link = CADisplayLink(
                    target: TextFirstFrameProxy(self),
                    selector: #selector(TextFirstFrameProxy.frame))
                link.add(to: .main, forMode: .common)
                self.link = link
            }
        }
    }

    /// Something that may let the note move again changed (the finger, the layout).
    func resume() {
        guard let link, link.isPaused else { return }
        last = nil
        link.isPaused = false
    }

    /// Parks the loop (the display link holds this object until then).
    func stop() {
        link?.invalidate()
        link = nil
        last = nil
    }

    isolated deinit { link?.invalidate() }

    fileprivate func frame(_ link: CADisplayLink) {
        // The first frame only starts the clock.
        defer { last = link.timestamp }
        guard let last else { return }
        if !scroll(TextFirstAutoscroll.step(velocity, elapsed: link.timestamp - last)) {
            link.isPaused = true
        }
    }
}

/// The display link's target, holding its autoscroller weakly (a link retains its target).
private final class TextFirstFrameProxy: NSObject {
    weak var autoscroller: TextFirstAutoscroller?
    init(_ autoscroller: TextFirstAutoscroller) { self.autoscroller = autoscroller }
    @MainActor @objc func frame(_ link: CADisplayLink) {
        if let autoscroller { autoscroller.frame(link) } else { link.invalidate() }
    }
}

/// Where a lifted block may land, as drawn now: each of the engine's slots on screen with the y
/// of its boundary, and the block's own top and bottom edges as far as they show, where a drop
/// would change nothing (nil when no part of the block shows). A lifted photo has no such edge
/// (every slot moves it, its own line's edges too), so both are its middle: held where it was,
/// it drops nowhere. `source` is the block's part on screen, the place the drag dims.
struct TextFirstDropTargets {
    let slots: [(slot: TextFirstBlockSlot, y: CGFloat)]
    let own: (top: CGFloat, bottom: CGFloat)?
    let source: CGRect?

    /// The slot nearest `y`; nil when one of the block's own edges is nearer (no drop line, and
    /// a release there returns the card).
    func slot(nearest y: CGFloat) -> (slot: TextFirstBlockSlot, y: CGFloat)? {
        guard let best = slots.min(by: { abs($0.y - y) < abs($1.y - y) }) else { return nil }
        guard let own else { return best }
        return abs(best.y - y) < min(abs(own.top - y), abs(own.bottom - y)) ? best : nil
    }
}

/// One lifted block's slots, kept by slot: the engine's answers for one unbroken stretch of the
/// note (UTF-16) around the screen. As the note scrolls only what newly comes near is asked
/// for and joined on at its end, and what has gone far from the screen is let go, so a long
/// drag costs what each scrolled stretch costs, never the whole note or the whole drag. The
/// reflow preview keys its slices by the same slots.
struct TextFirstSlotBook {
    /// The press, by which the engine names the block, and the block it names.
    let offset: Int
    let block: TextFirstLiftedBlock
    /// A photo lifted out of its line: it has no edges of its own.
    let alonePhoto: Bool
    let revision: UInt64
    private(set) var covered: NSRange?
    /// In display order.
    private(set) var slots: [TextFirstBlockSlot] = []

    init(offset: Int, block: TextFirstLiftedBlock, alonePhoto: Bool, revision: UInt64) {
        (self.offset, self.block, self.alonePhoto, self.revision) =
            (offset, block, alonePhoto, revision)
    }

    /// Have the slots of `near` (both ends included, as the engine reads a range), asking
    /// `fetch` only for the part not held. A stretch that does not touch what is held replaces
    /// it (the gap between is never asked for); anything further than twice `near`'s length
    /// from it is let go.
    mutating func reach(_ near: NSRange, fetch: (NSRange) throws -> [TextFirstBlockSlot]) rethrows {
        if let held = covered, near.location <= NSMaxRange(held), held.location <= NSMaxRange(near)
        {
            var covering = held
            if near.location < held.location {
                let found = try fetch(
                    NSRange(location: near.location, length: held.location - near.location))
                let edge = slots.prefix { $0.offset == held.location }
                slots.insert(contentsOf: found.filter { !edge.contains($0) }, at: 0)
                covering = NSUnionRange(covering, near)
            }
            if NSMaxRange(near) > NSMaxRange(held) {
                let found = try fetch(
                    NSRange(location: NSMaxRange(held), length: NSMaxRange(near) - NSMaxRange(held))
                )
                let edge = slots.reversed().prefix { $0.offset == NSMaxRange(held) }
                slots.append(contentsOf: found.filter { !edge.contains($0) })
                covering = NSUnionRange(covering, near)
            }
            covered = covering
        } else {
            slots = try fetch(near)
            covered = near
        }
        // Let go of what is far from the screen.
        guard let held = covered else { return }
        let from = max(held.location, near.location - 2 * near.length)
        let to = min(NSMaxRange(held), NSMaxRange(near) + 2 * near.length)
        if from > held.location || to < NSMaxRange(held) {
            slots = Array(slots(in: NSRange(location: from, length: to - from)))
            covered = NSRange(location: from, length: to - from)
        }
    }

    /// The slots whose offsets lie in `range` (both ends included).
    func slots(in range: NSRange) -> ArraySlice<TextFirstBlockSlot> {
        let from = slots.partitioningIndex { $0.offset >= range.location }
        let to = slots.partitioningIndex { $0.offset > NSMaxRange(range) }
        return slots[from..<max(from, to)]
    }
}

extension Array {
    /// The first index whose element satisfies `starts`, which must hold for a suffix.
    fileprivate func partitioningIndex(where starts: (Element) -> Bool) -> Int {
        var (low, high) = (0, count)
        while low < high {
            let mid = (low + high) / 2
            if starts(self[mid]) { high = mid } else { low = mid + 1 }
        }
        return low
    }
}

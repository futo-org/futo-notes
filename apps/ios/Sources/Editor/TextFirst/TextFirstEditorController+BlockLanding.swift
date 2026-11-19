import UIKit

// The release of a previewed block drag (#448). The card goes at once and the copy in the gap
// turns solid; the move is committed straight away, under the preview's curtain, as one Undo
// step; then the runs and the copy slide the few points left to where the moved note draws them
// (a box or indent the block gained on arrival fades in) and the curtain comes down when the
// slides end, at most 0.4 s after the release, uncovering the same picture. What shows does not
// move where the note's scroll allows; where it does not (the note came out shorter at its
// foot), it slides to the nearest offset the note has. No block lifts until the curtain is down.

/// The display lines a landing finds the runs by (`TextFirstEditorController.landingLines`).
struct TextFirstLandingLines {
    let base: Int
    let runs: [Int?]
    let block: Range<Int>
    let slot: Int
    let photo: Bool
}

/// A drop whose preview is settling over the moved note: what comes down when it ends, the
/// revision the move left the note at (any other change ends it at once), and the note's bounds
/// and content size it settles over (a scroll, a rotation or a relayout ends it at once too).
/// Going away, it takes what it shows down with it.
@MainActor
final class TextFirstReflowLanding {
    let preview: TextFirstReflow
    let dimmedSource: UIView
    let revision: UInt64
    let released: CFTimeInterval
    private let bounds: CGRect
    private let contentSize: CGSize
    init(
        _ preview: TextFirstReflow, dimmedSource: UIView, revision: UInt64,
        released: CFTimeInterval, on view: UIScrollView
    ) {
        (self.preview, self.dimmedSource, self.revision) = (preview, dimmedSource, revision)
        self.released = released
        (bounds, contentSize) = (view.bounds, view.contentSize)
    }

    /// Whether `view` has scrolled, resized or laid out to another size since the landing began.
    func disturbed(_ view: UIScrollView) -> Bool {
        view.bounds != bounds || abs(view.contentSize.height - contentSize.height) > 0.5
    }

    isolated deinit {
        preview.remove()
        dimmedSource.removeFromSuperview()
    }
}

extension TextFirstEditorController {
    /// The finger lifted (`dropping`) or iOS cancelled the touch during a previewed drag: move
    /// the block to the gap shown, or, with the gap at home or a move refused, let what slid
    /// go back and take the preview down.
    func landPreview(_ drag: TextFirstBlockDrag, _ preview: TextFirstReflow, dropping: Bool) {
        let released = CACurrentMediaTime()
        drag.handOffToLanding()
        drag.card.removeFromSuperview()
        drag.dropLine.removeFromSuperview()
        var moved = false
        if dropping, outsideChangesPending == 0, drag.lift.revision == rev, let slot = preview.slot
        {
            let interval = TextFirstReflowMotion.signposts.beginInterval("land")
            preview.solidify()
            moved = commitUnderPreview(drag, preview, to: slot)
            TextFirstReflowMotion.signposts.endInterval("land", interval)
            TextFirstReflowMotion.log.debug(
                "drop committed and settling in \((CACurrentMediaTime() - released) * 1000, format: .fixed(precision: 1), privacy: .public) ms"
            )
        }
        if !moved { withinScroll(preview) }
        let landing = TextFirstReflowLanding(
            preview, dimmedSource: drag.dimmedSource, revision: rev, released: released,
            on: textView)
        reflowLanding = landing
        if moved {
            dragHaptics.landed()
        } else {
            preview.retreat {}
        }
        let left = preview.isOpen ? max(0, preview.slidesEnd - CACurrentMediaTime()) : 0
        let wait = min(left, TextFirstReflowMotion.landingCap - (CACurrentMediaTime() - released))
        guard wait > 0 else { return finishLanding() }
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self, weak landing] in
            guard let self, let landing, self.reflowLanding === landing else { return }
            self.finishLanding()
        }
    }

    /// The curtain, the copy and the dim come down: the note under them is the moved note.
    func finishLanding() {
        guard let landing = reflowLanding else { return }
        reflowLanding = nil
        lastLanding = CACurrentMediaTime() - landing.released
        landing.preview.remove()
        landing.dimmedSource.removeFromSuperview()
    }

    /// Move the block to `slot` under the curtain, hold the screen still, and set the preview
    /// sliding to where the moved note is drawn. False when the engine refused the move.
    private func commitUnderPreview(
        _ drag: TextFirstBlockDrag, _ preview: TextFirstReflow, to slot: TextFirstBlockSlot
    ) -> Bool {
        let scrolled = textView.contentOffset
        let lines = landingLines(preview.plan, drag.book, to: slot)
        do {
            guard try moveBlock(at: drag.lift.offset, to: slot) else { return false }
        } catch {
            recover(error, context: "move block")
            return false
        }
        textView.layoutIfNeeded()
        if textView.contentOffset != scrolled {
            textView.contentOffset = scrolled
            textView.layoutIfNeeded()
        }
        // What shows is laid out again, around the text that moved, before any line is read.
        layOutViewport()
        let plan = preview.plan
        // The screen holds still: the line beside the gap that shows (above it if it does) is
        // drawn after the move where the preview drew it. The block may have left from far
        // above the screen, taking its height out above it, or TextKit may have settled its
        // estimate of the text above the screen, even under the curtain before the release:
        // where the preview drew is read against the curtain, not the screen.
        let visible = preview.visible
        let gap = preview.gap
        let beside = [gap - 1, gap].first { j in
            j >= 0 && j < plan.runs.count && !plan.runs[j].anchor.end && plan.runs[j].inset == 0
                && visible.contains(CGPoint(x: 1, y: plan.top(j, gap: gap)))
        }
        // The curtain follows the screen, what it draws staying where it is.
        preview.follow(boundsBy: textView.contentOffset.y - preview.visible.minY)
        var held = true
        var anchor = slot.offset
        if let j = beside, let line = lines.runs[j],
            let start = lineStart(
                TextFirstMoveMap.line(line, block: lines.block, to: lines.slot, photo: lines.photo),
                from: lines.base)
        {
            // Scrolling lays out what comes into view, which may settle TextKit's estimates
            // again: measure until the line holds, four times at most; still off after that,
            // the drop lands without the slide (and says so in the log).
            let edge = TextFirstBlockSlot(offset: start, end: false)
            anchor = start
            for pass in 0..<4 {
                // A long move can leave nothing laid out where the screen is: the line is laid
                // out on its own.
                let laidOut =
                    laidOutRange()
                    ?? (storage.string as NSString).lineRange(
                        for: NSRange(location: start, length: 0))
                if laidOutRange() == nil { ensureLayout(laidOut) }
                guard let top = edgeY(edge, laidOut) else { break }
                // Never above the note's top: blank there would spring back at the next touch.
                let offset = max(
                    top - plan.top(j, gap: gap) + visible.minY, -textView.adjustedContentInset.top)
                guard abs(offset - textView.contentOffset.y) > 0.25 else { break }
                held = pass < 3
                textView.contentOffset.y = offset
                textView.layoutIfNeeded()
                layOutViewport()
                preview.follow(boundsBy: textView.contentOffset.y - preview.visible.minY)
            }
        }
        // Below the note's foot (it came out shorter) the screen slides up to it with the runs.
        withinScroll(preview)
        // What shows is laid out before it is read and drawn, around the held line when TextKit
        // has left it so.
        if laidOutRange() == nil { ensureLayout(linesAround(anchor, count: 80)) }
        let landed = landedFrames(
            plan, gap: preview.gap, lines, shift: preview.visible.minY - visible.minY)
        if !held {
            TextFirstReflowMotion.log.error(
                "block drop: the screen did not hold still, landing without the slide")
        }
        preview.settle(
            runs: landed.runs, block: landed.block, drawable: laidOutBand() ?? .infinite,
            over: held ? TextFirstReflowMotion.slide : 0)
        return true
    }

    /// Scroll a note left beyond its foot (it came out shorter, or the preview drew it taller
    /// than it is) back to it, `preview` keeping what it draws where it is on screen: its
    /// slides then take it to where the note is drawn.
    private func withinScroll(_ preview: TextFirstReflow) {
        textView.layoutIfNeeded()
        preview.follow(boundsBy: textView.contentOffset.y - preview.visible.minY)
        // Only once the note's end is laid out is its foot known: TextKit's estimate of a
        // long stretch it has not laid out again can fall short of it.
        guard let manager = textView.textLayoutManager,
            let end = manager.textContentManager?.location(
                manager.documentRange.endLocation, offsetBy: -1),
            manager.textLayoutFragment(for: end)?.state == .layoutAvailable
        else { return }
        let insets = textView.adjustedContentInset
        let foot = max(
            -insets.top, textView.contentSize.height + insets.bottom - textView.bounds.height)
        let dy = foot - textView.contentOffset.y
        guard dy < -0.25 else { return }
        textView.contentOffset.y = foot
        textView.layoutIfNeeded()
        layOutViewport()
        preview.follow(boundsBy: dy)
    }

    /// The UTF-16 range of the `count` lines either side of the line holding `offset`.
    private func linesAround(_ offset: Int, count: Int) -> NSRange {
        let text = storage.string as NSString
        var from = min(offset, text.length)
        var to = from
        for _ in 0..<count where from > 0 {
            from = text.lineRange(for: NSRange(location: from - 1, length: 0)).location
        }
        for _ in 0..<count where to < text.length {
            to = NSMaxRange(text.lineRange(for: NSRange(location: to, length: 0)))
        }
        return NSRange(location: from, length: to - from)
    }

    /// What the landing finds each run by once the block has moved to `slot`, read before the
    /// move: the display line each run is measured from (nil for the note's end), the block's
    /// lines and the slot's, counted from the line start `base` above them all.
    func landingLines(
        _ plan: TextFirstReflowPlan, _ book: TextFirstSlotBook, to slot: TextFirstBlockSlot
    ) -> TextFirstLandingLines {
        let block = book.block.range
        // The block's end too: a block running below the screen ends beyond every run.
        let offsets =
            plan.runs.map(\.anchor.offset) + [block.location, NSMaxRange(block), slot.offset]
        let text = storage.string as NSString
        let base = text.lineRange(
            for: NSRange(location: min(offsets.min() ?? 0, text.length), length: 0)
        ).location
        // Down to the note's end only when the block or the slot is there.
        let reachesEnd = book.block.toEnd || slot.end || plan.runs.contains { $0.anchor.end }
        let starts = lineStarts(
            from: base, through: reachesEnd ? storage.length : (offsets.max() ?? 0) + 1)
        // The line holding `offset`; one past the last line for the note's end.
        func line(_ offset: Int, end: Bool = false) -> Int {
            if end { return starts.count }
            return starts.lastIndex { $0 <= offset } ?? 0
        }
        let first = line(block.location)
        let lines =
            book.alonePhoto
            ? first..<(first + 1)
            : first..<(book.block.toEnd ? starts.count : line(NSMaxRange(block)))
        return TextFirstLandingLines(
            base: base, runs: plan.runs.map { $0.anchor.end ? nil : line($0.anchor.offset) },
            block: lines, slot: line(slot.offset, end: slot.end), photo: book.alonePhoto)
    }

    /// Where each run of `plan`, and the block, are laid out now that the block has moved
    /// (text view coordinates), `lines` read before the move, the screen having moved `shift`
    /// to hold still. A run's top is where the line it is measured from is now; it ends where
    /// the next run, or the block, starts. A line that is not laid out is off screen: nothing
    /// is laid out to read it (TextKit would answer with an empty frame, and laying it out
    /// moves what shows), the run keeps the place the preview gave it, and the block's foot is
    /// taken from the copy's height.
    func landedFrames(
        _ plan: TextFirstReflowPlan, gap: Int, _ lines: TextFirstLandingLines, shift: CGFloat = 0
    ) -> (runs: [CGRect], block: CGRect?) {
        let width = textView.bounds.width
        let all = NSRange(location: 0, length: storage.length)
        let laidOut = laidOutRange() ?? all
        let last = (lines.runs.compactMap { $0 } + [lines.block.upperBound, lines.slot]).max() ?? 0
        let starts = lineStarts(from: lines.base, through: storage.length, lines: last + 2)
        let end = TextFirstBlockSlot(offset: storage.length, end: true)
        func top(ofLine k: Int) -> CGFloat? {
            boundaryY(
                k < starts.count ? TextFirstBlockSlot(offset: starts[k], end: false) : end,
                in: laidOut)
        }
        // The block's lines are where the move put them (a photo's, the line it became).
        var moved: CGRect?
        let first = TextFirstMoveMap.blockLine(lines.block, to: lines.slot, photo: lines.photo)
        if let upper = top(ofLine: first) {
            let lower =
                top(ofLine: first + (lines.photo ? 1 : lines.block.count))
                ?? upper + plan.away.height
            moved = CGRect(x: 0, y: upper, width: width, height: lower - upper)
        }
        let n = plan.runs.count
        var tops = plan.runs.indices.map { j -> CGFloat in
            let k = lines.runs[j].map {
                TextFirstMoveMap.line($0, block: lines.block, to: lines.slot, photo: lines.photo)
            }
            let was = plan.top(j, gap: gap) + shift
            let y = k.map { top(ofLine: $0) } ?? boundaryY(end, in: laidOut)
            return y.map { $0 + plan.runs[j].inset } ?? was
        }
        // A run measured from inside a line that closed up ends no lower than the next run.
        for j in stride(from: n - 2, through: 0, by: -1) where gap != j + 1 {
            tops[j] = min(tops[j], tops[j + 1])
        }
        let runs = (0..<n).map { j -> CGRect in
            let bottom =
                j + 1 == gap
                ? moved?.minY ?? tops[j] + plan.height(j, gap: gap)
                : j + 1 < n ? tops[j + 1] : tops[j] + plan.height(j, gap: gap)
            return CGRect(x: 0, y: tops[j], width: width, height: max(0, bottom - tops[j]))
        }
        return (runs, moved)
    }

    /// Lay out what shows now, as the next display pass would.
    func layOutViewport() {
        textView.textLayoutManager?.textViewportLayoutController.layoutViewport()
    }
}

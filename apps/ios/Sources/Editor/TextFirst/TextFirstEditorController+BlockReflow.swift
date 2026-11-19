import UIKit

// The block drag's live preview read from TextKit's layout (#448): the runs of the visible note
// between the engine's slots and the block's edges, where each is laid out, and, after the move
// is committed under the preview, where each is laid out now.

/// The display lines a landing finds the runs by (`TextFirstEditorController.landingLines`).
struct TextFirstLandingLines {
    let base: Int
    let runs: [Int?]
    let block: Range<Int>
    let slot: Int
    let photo: Bool
}

/// Why a drag's live preview could not be built: the drag shows the drop line instead.
struct TextFirstReflowUnavailable: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

extension TextFirstEditorController {
    /// A boundary the runs are cut at: its y, the text it is measured from, and the slot or
    /// home the gap may open on there.
    private struct Cut {
        let y: CGFloat
        let anchor: TextFirstBlockSlot
        let inset: CGFloat
        var slot: TextFirstBlockSlot? = nil
        var home = false
    }

    /// The preview of a drag of `book`'s block over the note as it is drawn now, `targets`
    /// being where its slots are drawn; for a photo lifted out of a line, that line laid out
    /// without it too (`reusing` the one laid out before when the width is the same).
    func reflowPlan(
        _ book: TextFirstSlotBook, _ targets: TextFirstDropTargets,
        reusing: TextFirstClosedLine? = nil
    ) throws -> (plan: TextFirstReflowPlan, closedLine: TextFirstClosedLine?) {
        guard let laidOut = laidOutRange(), storage.length > 0 else {
            throw TextFirstReflowUnavailable("the note is not laid out")
        }
        let visible = textView.bounds
        let block = book.block
        var cuts = targets.slots.map { Cut(y: $0.y, anchor: $0.slot, inset: 0, slot: $0.slot) }
        let source: CGRect
        let room: CGFloat
        var closing: TextFirstReflowPlan.Closing?
        var closedLine: TextFirstClosedLine?
        var spans: [(CGFloat, CGFloat)]
        let anchor: Int
        if book.alonePhoto {
            let line = (storage.string as NSString).lineRange(
                for: NSRange(location: block.range.location, length: 0))
            let start = TextFirstBlockSlot(offset: line.location, end: false)
            let end = TextFirstBlockSlot(
                offset: NSMaxRange(line), end: NSMaxRange(line) == storage.length)
            guard let photo = drawnImage(block.range, in: laidOut),
                let row = imageRow(block.range.location),
                let top = edgeY(start, laidOut), let bottom = edgeY(end, laidOut)
            else { throw TextFirstReflowUnavailable("the photo's line is not laid out") }
            let width = textView.textContainer.size.width
            guard
                let closed = reusing.flatMap({ $0.width == width ? $0 : nil })
                    ?? TextFirstClosedLine(
                        storage, line: line, removing: block.range, width: width)
            else { throw TextFirstReflowUnavailable("the photo's line did not lay out without it") }
            closedLine = closed
            // Home cuts the line at the photo's middle, or where the photo shows.
            let middle = min(max(photo.midY, visible.minY + 1), visible.maxY - 1)
            closing = TextFirstReflowPlan.Closing(
                top: top, bottom: bottom, anchor: line.location, photoTop: row.minY - top,
                rowBottom: row.maxY - top, home: middle - top, closed: closed.height)
            (source, room, anchor) = (photo, row.height, line.location)
            cuts += [
                Cut(y: top, anchor: start, inset: 0), Cut(y: bottom, anchor: end, inset: 0),
                Cut(y: middle, anchor: start, inset: middle - top, home: true),
            ]
            spans = [(visible.minY, visible.maxY)]
        } else {
            let start = TextFirstBlockSlot(offset: block.range.location, end: false)
            let end = TextFirstBlockSlot(offset: NSMaxRange(block.range), end: block.toEnd)
            ensureLayout(block.range)
            guard let top = edgeY(start, laidOut), let bottom = edgeY(end, laidOut), bottom > top
            else { throw TextFirstReflowUnavailable("the block's edges are not laid out") }
            source = CGRect(x: visible.minX, y: top, width: visible.width, height: bottom - top)
            (room, anchor) = (bottom - top, block.range.location)
            cuts.removeAll { $0.y > top + 0.5 && $0.y < bottom - 0.5 }
            cuts.append(Cut(y: bottom, anchor: end, inset: 0))
            spans = [
                (visible.minY, min(top, visible.maxY)), (max(bottom, visible.minY), visible.maxY),
            ]
        }
        var runs: [TextFirstReflowPlan.Run] = []
        var slots: [Int: TextFirstBlockSlot] = [:]
        var home: Int?
        for (from, to) in spans where to - from > 0.5 {
            if !book.alonePhoto, from >= source.maxY - 0.5 { home = runs.count }
            let at = cuts.filter { abs($0.y - from) < 0.5 }
            var edges = [at.first { $0.slot != nil } ?? at.first ?? cut(at: from, laidOut)]
            for cut in cuts.sorted(by: { $0.y < $1.y }) where cut.y > from + 0.5 && cut.y < to - 0.5
            {
                if let last = edges.last, cut.y - last.y < 0.5 {
                    if last.slot == nil, !last.home { edges[edges.count - 1] = cut }
                } else {
                    edges.append(cut)
                }
            }
            for (i, edge) in edges.enumerated() {
                let bottom = i + 1 < edges.count ? edges[i + 1].y : to
                if edge.home { home = runs.count }
                if let slot = edge.slot { slots[runs.count] = slot }
                let height = bottom - edge.y
                var closed = height
                if let line = closing, edge.y >= line.top - 0.5, bottom <= line.bottom + 0.5 {
                    closed = line.closedY(bottom - line.top) - line.closedY(edge.y - line.top)
                }
                runs.append(
                    TextFirstReflowPlan.Run(
                        anchor: edge.anchor, inset: edge.inset, top: edge.y, height: height,
                        closed: closed))
            }
            if let last = cuts.first(where: { abs($0.y - to) < 0.5 && $0.slot != nil }),
                to >= visible.maxY - 0.5
            {
                slots[runs.count] = last.slot
            }
        }
        if !book.alonePhoto, home == nil { home = runs.count }
        guard let home else { throw TextFirstReflowUnavailable("the photo's place is off screen") }
        let plan = TextFirstReflowPlan(
            runs: runs, home: home, slots: slots, source: source, room: room,
            left: book.alonePhoto ? 0 : room, sourceAnchor: anchor, closing: closing)
        return (plan, closedLine)
    }

    /// What the landing finds each run by once the block has moved to `slot`, read before the
    /// move: the display line each run is measured from (nil for the note's end), the block's
    /// lines and the slot's, counted from the line start `base` above them all.
    func landingLines(
        _ plan: TextFirstReflowPlan, _ book: TextFirstSlotBook, to slot: TextFirstBlockSlot
    ) -> TextFirstLandingLines {
        let block = book.block.range
        let offsets = plan.runs.map(\.anchor.offset) + [block.location, slot.offset]
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
    /// (text view coordinates), `lines` read before the move. A run's top is where the line it
    /// is measured from is now; it ends where the next run, or the block, starts.
    func landedFrames(_ plan: TextFirstReflowPlan, gap: Int, _ lines: TextFirstLandingLines)
        -> (runs: [CGRect], block: CGRect?)
    {
        let width = textView.bounds.width
        let all = NSRange(location: 0, length: storage.length)
        let last = (lines.runs.compactMap { $0 } + [lines.block.upperBound, lines.slot]).max() ?? 0
        let starts = lineStarts(from: lines.base, through: storage.length, lines: last + 2)
        let end = TextFirstBlockSlot(offset: storage.length, end: true)
        func top(ofLine k: Int) -> CGFloat? {
            edgeY(k < starts.count ? TextFirstBlockSlot(offset: starts[k], end: false) : end, all)
        }
        var moved: CGRect?
        let first = TextFirstMoveMap.blockLine(lines.block, to: lines.slot, photo: lines.photo)
        if first < starts.count, let lifted = try? liftedBlock(at: starts[first]),
            let top = edgeY(TextFirstBlockSlot(offset: lifted.range.location, end: false), all),
            let bottom = edgeY(
                TextFirstBlockSlot(offset: NSMaxRange(lifted.range), end: lifted.toEnd), all)
        {
            moved = CGRect(x: 0, y: top, width: width, height: bottom - top)
        }
        let n = plan.runs.count
        var tops = plan.runs.indices.map { j -> CGFloat in
            let k = lines.runs[j].map {
                TextFirstMoveMap.line($0, block: lines.block, to: lines.slot, photo: lines.photo)
            }
            let y = k.map { top(ofLine: $0) } ?? edgeY(end, all)
            return y.map { $0 + plan.runs[j].inset } ?? plan.top(j, gap: gap)
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

    /// The UTF-16 starts of the display lines from the line start `base` to `through`, at most
    /// `lines` of them.
    private func lineStarts(from base: Int, through: Int, lines: Int = .max) -> [Int] {
        let text = storage.string as NSString
        var starts = [base]
        var at = base
        while at < min(through, text.length), starts.count < lines {
            let found = text.range(
                of: "\n", options: .literal,
                range: NSRange(location: at, length: min(through, text.length) - at))
            guard found.location != NSNotFound else { break }
            at = NSMaxRange(found)
            starts.append(at)
        }
        return starts
    }

    /// Have TextKit lay out the lines of UTF-16 `range` now.
    private func ensureLayout(_ range: NSRange) {
        guard let manager = textView.textLayoutManager, let content = manager.textContentManager,
            let a = content.location(manager.documentRange.location, offsetBy: range.location),
            let b = content.location(
                manager.documentRange.location,
                offsetBy: min(NSMaxRange(range) + 1, storage.length)),
            let lines = NSTextRange(location: a, end: b)
        else { return }
        manager.ensureLayout(for: lines)
    }

    /// The y of `slot`, laying out the text between what is laid out and it when it is not.
    func edgeY(_ slot: TextFirstBlockSlot, _ laidOut: NSRange) -> CGFloat? {
        if let y = boundaryY(slot, in: laidOut) { return y }
        guard let manager = textView.textLayoutManager, let content = manager.textContentManager
        else { return nil }
        let from = min(slot.offset, laidOut.location)
        let to = min(max(slot.offset, NSMaxRange(laidOut)), storage.length)
        guard let a = content.location(manager.documentRange.location, offsetBy: from),
            let b = content.location(manager.documentRange.location, offsetBy: to),
            let range = NSTextRange(location: a, end: b)
        else { return nil }
        manager.ensureLayout(for: range)
        return boundaryY(slot, in: NSRange(location: from, length: to - from))
    }

    /// The row of the line holding UTF-16 `offset` (text view coordinates).
    private func imageRow(_ offset: Int) -> CGRect? {
        guard let manager = textView.textLayoutManager,
            let location = manager.textContentManager?.location(
                manager.documentRange.location, offsetBy: offset),
            let f = manager.textLayoutFragment(for: location)
        else { return nil }
        let local =
            offset
            - manager.offset(
                from: manager.documentRange.location, to: f.rangeInElement.location)
        guard
            let row = f.textLineFragments.first(where: {
                NSLocationInRange(local, $0.characterRange)
            })
        else { return nil }
        return row.typographicBounds.offsetBy(
            dx: inset.left + f.layoutFragmentFrame.minX, dy: inset.top + f.layoutFragmentFrame.minY)
    }

    /// A cut at `y` that is no boundary (the screen's edge): measured from the line drawn there.
    private func cut(at y: CGFloat, _ laidOut: NSRange) -> Cut {
        if let manager = textView.textLayoutManager,
            let f = manager.textLayoutFragment(for: CGPoint(x: 1, y: y - inset.top))
        {
            let start = manager.offset(
                from: manager.documentRange.location, to: f.rangeInElement.location)
            return Cut(
                y: y, anchor: TextFirstBlockSlot(offset: start, end: false),
                inset: y - inset.top - f.layoutFragmentFrame.minY)
        }
        let end = TextFirstBlockSlot(offset: storage.length, end: true)
        if let bottom = boundaryY(end, in: laidOut), y >= bottom {
            return Cut(y: y, anchor: end, inset: y - bottom)
        }
        // Above what is laid out: measured from its first line, never from the note's start
        // (drawing from there would lay out the whole note above the screen).
        let first = TextFirstBlockSlot(offset: laidOut.location, end: false)
        let top = boundaryY(first, in: laidOut) ?? y
        return Cut(y: y, anchor: first, inset: y - top)
    }
}

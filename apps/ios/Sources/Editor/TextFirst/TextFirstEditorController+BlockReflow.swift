import UIKit

// The block drag's live preview read from TextKit's layout (#448): the runs of the visible note
// between the engine's slots and the block's edges, and where each is laid out.

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
    /// without it too (`reusing` the one laid out before when it still draws the same). Runs
    /// cover the lines that show, from the start of the line at the screen's top to the end of
    /// the line at its foot, so a run starts at a line start and keeps it as the note scrolls.
    /// When the block is no longer near the screen (#449), what it takes out of its place and
    /// needs in a gap are `known` from when it was; an edge of it that is not laid out is
    /// where the block laid out on its own puts it.
    func reflowPlan(
        _ book: TextFirstSlotBook, _ targets: TextFirstDropTargets,
        reusing: TextFirstClosedLine? = nil, known: (room: CGFloat, left: CGFloat)? = nil,
        measured: CGFloat? = nil
    ) throws -> (plan: TextFirstReflowPlan, closedLine: TextFirstClosedLine?) {
        guard let laidOut = laidOutRange(), storage.length > 0 else {
            throw TextFirstReflowUnavailable("the note is not laid out")
        }
        let visible = textView.bounds
        let block = book.block
        var cuts = targets.slots.map { Cut(y: $0.y, anchor: $0.slot, inset: 0, slot: $0.slot) }
        let window = (top: cut(at: visible.minY, laidOut), bottom: lineEnd(at: visible.maxY))
        let source: CGRect
        let away: CGRect
        let room: CGFloat
        var left: CGFloat
        var drawing = 0
        var closing: TextFirstReflowPlan.Closing?
        var closedLine: TextFirstClosedLine?
        var spans: [(CGFloat, CGFloat)] = [(window.top.y, window.bottom)]
        let anchor: Int
        // Whether the block's place was put beside what shows, not read from any layout: the
        // note there is other text, never drawn as the block. Whether its height is measured
        // rather than estimated.
        var placed = false
        var exact = false
        // Which side of what shows the block is on when it does not show.
        let above = block.range.location < laidOut.location
        if book.alonePhoto {
            let line = (storage.string as NSString).noteLine(at: block.range.location)
            let start = TextFirstBlockSlot(offset: line.location, end: false)
            // A line ending at the text's end ends at the note's end unless a line ending
            // closes it: then an empty last line (an empty task) follows, with its own row.
            let ends = storage.string.utf16.last != 0x0A
            let end = TextFirstBlockSlot(
                offset: NSMaxRange(line), end: NSMaxRange(line) == storage.length && ends)
            drawing = drawingSignature(line)
            let width = textView.textContainer.size.width
            if let photo = drawnImage(block.range, in: laidOut),
                let row = imageRow(block.range.location),
                let top = boundaryY(start, in: laidOut), let bottom = boundaryY(end, in: laidOut)
            {
                guard
                    let closed = reusing.flatMap({
                        $0.width == width && $0.drawing == drawing ? $0 : nil
                    })
                        ?? TextFirstClosedLine(
                            storage, line: line, removing: block.range, width: width,
                            drawing: drawing)
                else {
                    throw TextFirstReflowUnavailable("the photo's line did not lay out without it")
                }
                closedLine = closed
                // Home cuts the line at the photo's middle, or where the photo shows.
                let middle = min(max(photo.midY, visible.minY + 1), visible.maxY - 1)
                closing = TextFirstReflowPlan.Closing(
                    top: top, bottom: bottom, anchor: line.location, photoTop: row.minY - top,
                    rowBottom: row.maxY - top, home: middle - top, closed: closed.height)
                (source, room, left, anchor) = (photo, closed.photoHeight, 0, line.location)
                cuts += [
                    Cut(y: top, anchor: start, inset: 0), Cut(y: bottom, anchor: end, inset: 0),
                    Cut(y: middle, anchor: start, inset: middle - top, home: true),
                ]
            } else {
                // Its line has scrolled away: it closed up by what it was known to (`left`),
                // unless it draws otherwise now (the photo loaded, a new width): then the line
                // is laid out again apart, with and without the photo.
                guard let known, let before = reusing else {
                    throw TextFirstReflowUnavailable("the photo's line is not laid out")
                }
                if before.width == width, before.drawing == drawing {
                    closedLine = before
                    (room, left) = (known.room, known.left)
                } else {
                    guard
                        let closed = TextFirstClosedLine(
                            storage, line: line, removing: block.range, width: width,
                            drawing: drawing),
                        let whole = TextFirstBlockLayout(
                            storage, block: line, width: width, drawing: drawing, host: self)
                    else {
                        throw TextFirstReflowUnavailable(
                            "the photo's line did not lay out without it")
                    }
                    closedLine = closed
                    (room, left) = (closed.photoHeight, max(0, whole.height - closed.height))
                }
                anchor = line.location
                placed = true
                source = CGRect(
                    x: visible.minX, y: above ? window.top.y - room : window.bottom,
                    width: visible.width, height: room)
            }
            away = CGRect(x: visible.minX, y: 0, width: visible.width, height: room)
        } else {
            let start = TextFirstBlockSlot(offset: block.range.location, end: false)
            let end = TextFirstBlockSlot(offset: NSMaxRange(block.range), end: block.toEnd)
            // Only what is near the screen is laid out, and nothing for a block that has none
            // of it.
            let near = NSIntersectionRange(block.range, laidOut)
            if near.length > 0 { ensureLayout(near) }
            var top = boundaryY(start, in: laidOut)
            var bottom = boundaryY(end, in: laidOut)
            let measuredBottom = bottom != nil
            // An edge beyond what is laid out is where the block laid out on its own puts it:
            // from its other edge, or from its line at the screen's top; off screen altogether,
            // beside what shows.
            exact = top != nil && bottom != nil
            if !exact {
                // Its height measured (laid out whole, or read from both edges once) before
                // one estimated from its first stretch.
                let own = blockLayout(block.range)
                let height =
                    own.flatMap { $0.exact ? $0.height : nil } ?? measured ?? own?.height
                    ?? known?.left ?? visible.height
                exact = own?.exact == true || measured != nil
                if let at = top {
                    bottom = at + height
                } else if let at = bottom {
                    top = at - height
                } else if !window.top.anchor.end,
                    let y = own?.y(ofLineAt: window.top.anchor.offset)
                {
                    top = window.top.y - y
                } else {
                    top = above ? window.top.y - height : window.bottom
                    placed = true
                }
                bottom = bottom ?? top.map { $0 + height }
            }
            guard let top, let bottom, bottom > top
            else { throw TextFirstReflowUnavailable("the block's edges are not laid out") }
            source = CGRect(x: visible.minX, y: top, width: visible.width, height: bottom - top)
            (room, left, anchor) = (bottom - top, bottom - top, block.range.location)
            away = CGRect(x: source.minX, y: 0, width: source.width, height: source.height)
            cuts.removeAll { $0.y > top + 0.5 && $0.y < bottom - 0.5 }
            // An edge that is not laid out is no line start a run can be measured from.
            if measuredBottom { cuts.append(Cut(y: bottom, anchor: end, inset: 0)) }
            spans = [
                (window.top.y, min(top, window.bottom)), (max(bottom, window.top.y), window.bottom),
            ]
        }
        var runs: [TextFirstReflowPlan.Run] = []
        var slots: [Int: TextFirstBlockSlot] = [:]
        var home: Int?
        let lifted = closing != nil || !book.alonePhoto
        for (from, to) in spans where to - from > 0.5 {
            if !book.alonePhoto, from >= source.maxY - 0.5, home == nil { home = runs.count }
            let at = cuts.filter { abs($0.y - from) < 0.5 }
            var edges = [
                at.first { $0.slot != nil } ?? at.first
                    ?? (abs(from - window.top.y) < 0.5 ? window.top : cut(at: from, laidOut))
            ]
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
                        closed: closed, drawing: 0))
            }
            if let last = cuts.first(where: { abs($0.y - to) < 0.5 && $0.slot != nil }),
                to >= window.bottom - 0.5
            {
                slots[runs.count] = last.slot
            }
        }
        // A block whose place does not show has its home beyond the runs on its side, so it
        // is never a boundary a slot is at.
        let homeShown = source.intersects(visible) && lifted
        if !homeShown {
            home = source.midY < visible.midY ? -1 : runs.count + 1
        } else if home == nil, !book.alonePhoto {
            // Running below what shows: its place is after every run.
            home = runs.count
        }
        guard let home else { throw TextFirstReflowUnavailable("the photo's place is off screen") }
        // What each run draws, so a run is drawn again when an image in it changes.
        for j in runs.indices {
            let from = runs[j].anchor.offset
            let to = j + 1 < runs.count ? runs[j + 1].anchor.offset : NSMaxRange(laidOut)
            runs[j].drawing = drawingSignature(
                NSRange(location: from, length: max(0, min(to, storage.length) - from)))
        }
        let band = laidOutBand()
        let plan = TextFirstReflowPlan(
            runs: runs, home: home, homeShown: homeShown, slots: slots, source: source,
            room: room, left: left, away: away, drawing: drawing,
            blockDrawing: drawingSignature(block.range), exact: exact, sourceAnchor: anchor,
            sourceLaidOut: placed
                ? nil
                : band.flatMap { b in
                    let top = max(b.minY, source.minY)
                    let bottom = min(b.maxY, source.maxY)
                    return top < bottom ? top...bottom : nil
                }, closing: closing)
        return (plan, closedLine)
    }

    /// `block` laid out on its own, once for the drag, and again when it draws otherwise
    /// (an image in it loaded, a new width).
    func blockLayout(_ block: NSRange) -> TextFirstBlockLayout? {
        let width = textView.textContainer.size.width
        let drawing = drawingSignature(block)
        if let own = liftedLayout, own.range == block, own.width == width, own.drawing == drawing {
            return own
        }
        liftedLayout = TextFirstBlockLayout(
            storage, block: block, width: width, drawing: drawing, host: self)
        return liftedLayout
    }

    /// What the images in UTF-16 `range` draw: each one's place, its size, and whether it has
    /// decoded or failed.
    private func drawingSignature(_ range: NSRange) -> Int {
        var hasher = Hasher()
        storage.enumerateAttribute(.tfImage, in: range) { value, run, _ in
            guard let span = value as? TextFirstImageSpan else { return }
            hasher.combine(run.location)
            hasher.combine(span.size.width)
            hasher.combine(span.size.height)
            hasher.combine(span.atom.image.map(ObjectIdentifier.init))
            hasher.combine(span.atom.failed)
        }
        return hasher.finalize()
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

    /// The window's top: the start of the line drawn at `y` (the screen's top edge), or, below
    /// the text, its end; above what is laid out, its first line.
    private func cut(at y: CGFloat, _ laidOut: NSRange) -> Cut {
        if let manager = textView.textLayoutManager,
            let f = manager.textLayoutFragment(for: CGPoint(x: 1, y: y - inset.top))
        {
            let start = manager.offset(
                from: manager.documentRange.location, to: f.rangeInElement.location)
            let top = inset.top + f.layoutFragmentFrame.minY
            // TextKit starts a paragraph inside a line at U+2029, U+0085 or a lone return:
            // the run is measured from the line's start, as the landing finds lines.
            let line = (storage.string as NSString).noteLine(at: start).location
            if line != start,
                let lineTop = boundaryY(
                    TextFirstBlockSlot(offset: line, end: false), in: laidOut)
            {
                return Cut(
                    y: top, anchor: TextFirstBlockSlot(offset: line, end: false),
                    inset: top - lineTop)
            }
            return Cut(y: top, anchor: TextFirstBlockSlot(offset: start, end: false), inset: 0)
        }
        let end = TextFirstBlockSlot(offset: storage.length, end: true)
        if let bottom = boundaryY(end, in: laidOut), y >= bottom {
            return Cut(y: y, anchor: end, inset: y - bottom)
        }
        let first = TextFirstBlockSlot(offset: laidOut.location, end: false)
        return Cut(y: boundaryY(first, in: laidOut) ?? y, anchor: first, inset: 0)
    }

    /// The window's foot: the end of the line drawn at `y` (the screen's foot), or `y` itself
    /// below the text.
    private func lineEnd(at y: CGFloat) -> CGFloat {
        guard let manager = textView.textLayoutManager,
            let f = manager.textLayoutFragment(for: CGPoint(x: 1, y: y - inset.top))
        else { return y }
        return max(y, inset.top + f.layoutFragmentFrame.maxY)
    }
}

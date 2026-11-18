import UIKit

// What a long-press lifts and where it may land on screen (#311, #446). The engine names the
// block and its slots; the view finds the position under the finger and the y of each slot. A lift
// asks the engine only for the slots inside the laid-out viewport, in one call, so it costs the
// same in a long note as in a short one.

extension TextFirstEditorController {
    /// What a long-press at `p` (text view coordinates) lifts; nil when the press keeps the
    /// platform's long-press: a blank line, an empty note, front matter, code nothing closes, or
    /// anything `mayLift` rules out.
    func liftPlan(at p: CGPoint) -> TextFirstLift? {
        guard mayLift, let offset = pressOffset(at: p), let laidOut = laidOutRange() else {
            return nil
        }
        let block: TextFirstLiftedBlock
        let slots: [TextFirstBlockSlot]
        do {
            guard let found = try liftedBlock(at: offset) else { return nil }
            (block, slots) = (found, try blockSlots(at: offset, within: laidOut))
        } catch {
            print("text-first: block lookup failed: \(error)")
            return nil
        }
        // What shows: the text view's bounds less what the keyboard covers.
        let insets = textView.adjustedContentInset
        let shown = textView.bounds.inset(
            by: UIEdgeInsets(top: insets.top, left: 0, bottom: insets.bottom, right: 0))
        let frame: CGRect
        let own: (top: CGFloat, bottom: CGFloat)
        // A photo that lifted alone: the card is the photo, and having no edges of its own (its
        // line's edges are slots) it drops nowhere while the finger stays over its middle. A
        // photo alone on its line lifts the line, with the line's card and edges.
        if let photo = imageAt(p), photo.range == block.range, !coversWholeLines(block.range) {
            frame = photo.frame.intersection(shown)
            own = (frame.midY, frame.midY)
        } else {
            let topEdge = TextFirstBlockSlot(offset: block.range.location, end: false)
            let bottomEdge = TextFirstBlockSlot(offset: NSMaxRange(block.range), end: block.toEnd)
            let top = max(boundaryY(topEdge, in: laidOut) ?? -.infinity, shown.minY)
            let bottom = min(boundaryY(bottomEdge, in: laidOut) ?? .infinity, shown.maxY)
            frame = CGRect(x: 0, y: top, width: textView.bounds.width, height: bottom - top)
            own = (top, bottom)
        }
        guard !frame.isNull, frame.height > 0 else { return nil }
        let targets = TextFirstDropTargets(
            slots: slots.compactMap { slot in
                boundaryY(slot, in: laidOut).flatMap {
                    shown.minY...shown.maxY ~= $0 ? (slot, $0) : nil
                }
            },
            ownTop: own.top, ownBottom: own.bottom)
        return TextFirstLift(
            offset: offset, block: block.range, frame: frame, targets: targets, revision: rev)
    }

    /// The UTF-16 range TextKit has laid out (the viewport and a margin around it): where a y can
    /// be read without laying out text that is not shown.
    private func laidOutRange() -> NSRange? {
        guard let manager = textView.textLayoutManager,
            let viewport = manager.textViewportLayoutController.viewportRange
        else { return nil }
        let begin = manager.documentRange.location
        let start = manager.offset(from: begin, to: viewport.location)
        return NSRange(
            location: start, length: manager.offset(from: begin, to: viewport.endLocation) - start)
    }

    /// The UTF-16 display offset under `p`, as the engine reads a press: on a photo, the photo's
    /// start; elsewhere the character nearest the finger on the row at `p`'s height, anywhere
    /// across the page (its margins too), never one inside a photo; the display's end on the
    /// note's empty last line. Nil off the text.
    private func pressOffset(at p: CGPoint) -> Int? {
        if let photo = imageAt(p) { return photo.range.location }
        guard let manager = textView.textLayoutManager,
            let f = manager.textLayoutFragment(for: CGPoint(x: 1, y: p.y - inset.top))
        else { return nil }
        let local = CGPoint(x: p.x - inset.left, y: p.y - inset.top - f.layoutFragmentFrame.minY)
        // The empty last line lays out as a zero-length line at the end of the last paragraph.
        if let last = f.textLineFragments.last, last.characterRange.length == 0,
            f.textLineFragments.count > 1, local.y >= last.typographicBounds.minY
        {
            return storage.length
        }
        let start = manager.offset(
            from: manager.documentRange.location, to: f.rangeInElement.location)
        // The row at the finger's height, or the one above the line spacing it is in.
        guard
            let row = f.textLineFragments.last(where: { $0.typographicBounds.minY <= local.y })
                ?? f.textLineFragments.first
        else { return start }
        let bounds = row.typographicBounds
        let index = row.characterIndex(
            for: CGPoint(x: local.x - bounds.minX, y: local.y - bounds.minY))
        // At most the row's last character: past it is the line ending, or the next row's. Both
        // steps land on a character's start, never inside a surrogate pair the engine cannot
        // read (the end of a row ending in an emoji is two units past its start).
        let range = row.characterRange
        let last = characterStart(start + max(range.location, NSMaxRange(range) - 1)) - start
        var at = characterStart(start + min(max(index, range.location), last)) - start
        // Off a photo, a position inside one (beside it in the margin) steps past it: the engine
        // would lift that photo, which the finger is not on.
        let photos = (f as? TextFirstLayoutFragment)?.imageRuns.map(\.range) ?? []
        while let photo = photos.first(where: { NSLocationInRange(at, $0) }) {
            at = NSMaxRange(photo)
        }
        return start + at
    }

    /// The start of the character holding UTF-16 `offset` (the text's end stays itself).
    private func characterStart(_ offset: Int) -> Int {
        guard offset < storage.length else { return offset }
        return (storage.string as NSString).rangeOfComposedCharacterSequence(at: offset).location
    }

    /// Whether UTF-16 `range` runs from a display line's start to the start of a line after it
    /// (or the text's end): what lifts with its lines. A photo lifted alone shares its line with
    /// text that shows, so its range never does; a photo alone on its line lifts that line, and
    /// its range can then equal the line's.
    private func coversWholeLines(_ range: NSRange) -> Bool {
        let text = storage.string as NSString
        let end = NSMaxRange(range)
        let startsLine = range.location == 0 || text.character(at: range.location - 1) == 0x0A
        let endsLine = end == text.length || (end > 0 && text.character(at: end - 1) == 0x0A)
        return startsLine && endsLine
    }

    /// The y (text view coordinates) of boundary `slot`: the top of the line that starts at its
    /// offset, or for the note's end the bottom of the last row, the empty one after a final line
    /// ending included (an empty task draws its box there). At the text's end, a boundary that is
    /// not the note's end is that empty row's top, where the last row with text ends. Nil outside
    /// `laidOut`, where asking would lay out text that is not shown.
    private func boundaryY(_ slot: TextFirstBlockSlot, in laidOut: NSRange) -> CGFloat? {
        guard laidOut.location <= slot.offset, slot.offset <= NSMaxRange(laidOut),
            storage.length > 0, let manager = textView.textLayoutManager,
            let content = manager.textContentManager
        else { return nil }
        let atEnd = slot.offset >= storage.length
        guard
            let location = content.location(
                manager.documentRange.location,
                offsetBy: atEnd ? characterStart(storage.length - 1) : slot.offset),
            let f = manager.textLayoutFragment(for: location)
        else { return nil }
        let top = inset.top + f.layoutFragmentFrame.minY
        guard atEnd else { return top }
        let rows = f.textLineFragments
        let row = slot.end ? rows.last : rows.last { $0.characterRange.length > 0 }
        return top + (row?.typographicBounds.maxY ?? f.layoutFragmentFrame.height)
    }
}

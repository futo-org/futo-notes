import UIKit

// What a long-press lifts and where it may land on screen (#311, #446, #443). The engine names
// the block and its slots; the view finds the position under the finger and the y of each slot.
// The view asks the engine only for the slots inside the laid-out viewport, in one call, so a lift
// costs the same in a long note as in a short one, and asks again only for what scrolls near.

extension TextFirstEditorController {
    /// What a long-press at `p` (text view coordinates) lifts; nil when the press keeps the
    /// platform's long-press: a blank line, an empty note, front matter, code nothing closes, or
    /// anything `mayLift` rules out.
    func liftPlan(at p: CGPoint) -> TextFirstLift? {
        guard mayLift, let offset = pressOffset(at: p) else { return nil }
        do {
            guard let block = try liftedBlock(at: offset) else { return nil }
            // A photo lifted alone shares its line with text that shows, so its range never
            // covers whole lines; a photo alone on its line lifts the line, whose range can
            // then equal the photo's.
            let photo = imageAt(p).map { $0.range == block.range && !coversWholeLines(block.range) }
            var book = TextFirstSlotBook(
                offset: offset, block: block, alonePhoto: photo ?? false, revision: rev)
            let targets = try dropTargets(&book)
            guard let frame = targets.source else { return nil }
            return TextFirstLift(book: book, frame: frame, targets: targets)
        } catch {
            print("text-first: block lookup failed: \(error)")
            return nil
        }
    }

    /// Where the block `book` lifted may land as the note is drawn now: the one place a drag
    /// reads its targets, at the lift and every time the layout or the scroll changes. Asks the
    /// engine for the slots of whatever part of the laid-out viewport it has not asked about
    /// (one call and one conversion), then reads each slot's y, and the block's own edges and
    /// place, from TextKit's real layout, within what shows: the text view's bounds less what
    /// the keyboard and the bars cover. Text TextKit has not laid out has no y yet; it is read
    /// once it is.
    func dropTargets(_ book: inout TextFirstSlotBook) throws -> TextFirstDropTargets {
        guard let laidOut = laidOutRange() else {
            return TextFirstDropTargets(slots: [], own: nil, source: nil)
        }
        let press = book.offset
        try book.reach(laidOut) { try blockSlots(at: press, within: $0) }
        let insets = textView.adjustedContentInset
        let shown = textView.bounds.inset(
            by: UIEdgeInsets(top: insets.top, left: 0, bottom: insets.bottom, right: 0))
        let slots = book.slots(in: laidOut).compactMap { slot in
            boundaryY(slot, in: laidOut).flatMap {
                shown.minY...shown.maxY ~= $0 ? (slot: slot, y: $0) : nil
            }
        }
        let block = book.block
        // A photo lifted alone: its place is the photo, and having no edges of its own (its
        // line's edges are slots) it drops nowhere while the finger stays over its middle.
        if book.alonePhoto {
            guard let photo = drawnImage(block.range, in: laidOut)?.intersection(shown),
                !photo.isNull, photo.height > 0
            else { return TextFirstDropTargets(slots: slots, own: nil, source: nil) }
            return TextFirstDropTargets(
                slots: slots, own: (photo.midY, photo.midY), source: photo)
        }
        // An edge outside the laid-out stretch is beyond the side of it that it is on.
        func y(_ edge: TextFirstBlockSlot) -> CGFloat {
            boundaryY(edge, in: laidOut)
                ?? (edge.offset < laidOut.location ? -.infinity : .infinity)
        }
        let top = max(y(TextFirstBlockSlot(offset: block.range.location, end: false)), shown.minY)
        let bottom = min(
            y(TextFirstBlockSlot(offset: NSMaxRange(block.range), end: block.toEnd)), shown.maxY)
        guard top < bottom else { return TextFirstDropTargets(slots: slots, own: nil, source: nil) }
        return TextFirstDropTargets(
            slots: slots, own: (top, bottom),
            source: CGRect(x: 0, y: top, width: textView.bounds.width, height: bottom - top))
    }

    /// The UTF-16 range TextKit has laid out (the viewport and a margin around it): where a y can
    /// be read without laying out text that is not shown.
    func laidOutRange() -> NSRange? {
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
        guard let manager = textView.textLayoutManager else { return nil }
        // The empty last line lays out as a zero-length line at the end of the last paragraph,
        // and is pressed where it is drawn, which can be below the fragment TextKit measured.
        if let last = lastFragment(), let row = last.trailingRowFrame {
            let top = inset.top + last.layoutFragmentFrame.minY
            if (top + row.top...top + row.top + row.height) ~= p.y { return storage.length }
        }
        guard let f = manager.textLayoutFragment(for: CGPoint(x: 1, y: p.y - inset.top)) else {
            return nil
        }
        let local = CGPoint(x: p.x - inset.left, y: p.y - inset.top - f.layoutFragmentFrame.minY)
        let start = manager.offset(
            from: manager.documentRange.location, to: f.rangeInElement.location)
        // The row at the finger's height, or the one above the line spacing it is in; never the
        // empty last line, which is pressed only where it is drawn (above).
        guard
            let row = f.textLineFragments.last(where: {
                $0.characterRange.length > 0 && $0.typographicBounds.minY <= local.y
            }) ?? f.textLineFragments.first
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
    /// offset, or for the note's end the bottom of the last row. The note's empty last line
    /// after a final line ending is read where it is drawn: a boundary at
    /// the text's end that is not the note's end is that row's top, and the note's end its
    /// bottom. Nil outside `laidOut`, where asking would lay out text that is not shown.
    func boundaryY(_ slot: TextFirstBlockSlot, in laidOut: NSRange) -> CGFloat? {
        guard laidOut.location <= slot.offset, slot.offset <= NSMaxRange(laidOut),
            storage.length > 0, let manager = textView.textLayoutManager,
            let content = manager.textContentManager
        else { return nil }
        let atEnd = slot.offset >= storage.length
        let f =
            atEnd
            ? lastFragment()
            : content.location(manager.documentRange.location, offsetBy: slot.offset)
                .flatMap { manager.textLayoutFragment(for: $0) }
        guard let f else { return nil }
        let top = inset.top + f.layoutFragmentFrame.minY
        guard atEnd else { return top }
        if let row = (f as? TextFirstLayoutFragment)?.trailingRowFrame {
            return top + row.top + (slot.end ? row.height : 0)
        }
        let text = f.textLineFragments.last { $0.characterRange.length > 0 }
        return top + (text?.typographicBounds.maxY ?? f.layoutFragmentFrame.height)
    }

    /// Where the image at UTF-16 `range` is drawn (text view coordinates), when TextKit has laid
    /// it out.
    func drawnImage(_ range: NSRange, in laidOut: NSRange) -> CGRect? {
        guard NSLocationInRange(range.location, laidOut), let manager = textView.textLayoutManager,
            let location = manager.textContentManager?.location(
                manager.documentRange.location, offsetBy: range.location),
            let f = manager.textLayoutFragment(for: location) as? TextFirstLayoutFragment
        else { return nil }
        let base = manager.offset(
            from: manager.documentRange.location, to: f.rangeInElement.location)
        guard let run = f.imageRuns.first(where: { base + $0.range.location == range.location }),
            let rect = f.imageRect(run)
        else { return nil }
        return rect.offsetBy(dx: inset.left, dy: inset.top + f.layoutFragmentFrame.minY)
    }

    /// The fragment of the note's last paragraph, which holds its empty last line.
    func lastFragment() -> TextFirstLayoutFragment? {
        guard storage.length > 0, let manager = textView.textLayoutManager,
            let location = manager.textContentManager?.location(
                manager.documentRange.location, offsetBy: characterStart(storage.length - 1))
        else { return nil }
        return manager.textLayoutFragment(for: location) as? TextFirstLayoutFragment
    }
}

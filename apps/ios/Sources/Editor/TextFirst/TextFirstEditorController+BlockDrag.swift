import UIKit

// Long-press block drag (#441: an experiment awaiting the maintainer's verdict; #311 holds the
// design). A press that holds still lifts the block the engine says the line under it lifts: a
// snapshot card of the block follows the finger, the source dims in place, a drop line marks the
// engine's slot nearest the finger, and releasing moves the block there as one Undo step
// (+BlockMove). The view decides only which line is under the finger and which slot is nearest.

/// When a press lifts a block: the experiment's knobs, and only here.
enum TextFirstLiftPolicy {
    /// How long a press holds before it lifts (the old web editor's value).
    static let holdDuration: TimeInterval = 0.34
    /// How far, in points, the finger may wander while it holds.
    static let movementTolerance: CGFloat = 10
    /// The first fallback should losing the loupe hurt (#311): lift only while the keyboard is
    /// down, leaving the platform's long-press to an editing note.
    static let onlyWhileKeyboardDown = false

    /// Whether a press may lift anything, before the line under it is asked. An editor still
    /// opening, and one with a table cell open, keep the platform's long-press everywhere; the
    /// title is another view and never sees this gesture.
    static func mayLift(editorReady: Bool, cellOpen: Bool, keyboardUp: Bool) -> Bool {
        editorReady && !cellOpen && !(onlyWhileKeyboardDown && keyboardUp)
    }
}

/// Where a lifted block may land on screen: each of the engine's slots on screen with the y of
/// its boundary, and the y of the block's own two edges, where a drop would change nothing.
struct TextFirstDropTargets {
    let slots: [(offset: Int, y: CGFloat)]
    let ownEdges: [CGFloat]

    /// The slot nearest `y`; nil when one of the block's own edges is nearer (no drop line, and
    /// a release there returns the card).
    func slot(nearest y: CGFloat) -> (offset: Int, y: CGFloat)? {
        guard let best = slots.min(by: { abs($0.y - y) < abs($1.y - y) }) else { return nil }
        let own = ownEdges.map { abs($0 - y) }.min() ?? .infinity
        return abs(best.y - y) < own ? best : nil
    }
}

/// One drag in progress: what was lifted and the views drawn for it.
@MainActor
final class TextFirstBlockDrag {
    /// The UTF-16 offset of the line pressed, and the block it lifts.
    let line: Int
    let block: NSRange
    let targets: TextFirstDropTargets
    let start: CGPoint
    let card: UIView
    let dim: UIView
    let dropLine: UIView
    let home: CGPoint
    private(set) var slot: Int?

    init(
        line: Int, block: NSRange, targets: TextFirstDropTargets, start: CGPoint, frame: CGRect,
        snapshot: UIView, in host: UIView, background: UIColor, accent: UIColor,
        dropLineX: ClosedRange<CGFloat>
    ) {
        (self.line, self.block, self.targets, self.start) = (line, block, targets, start)
        dim = UIView(frame: frame)
        dim.backgroundColor = background.withAlphaComponent(0.65)
        card = UIView(frame: frame)
        card.backgroundColor = background
        card.layer.cornerRadius = 8
        card.layer.shadowColor = UIColor.black.cgColor
        card.layer.shadowOpacity = 0.25
        card.layer.shadowRadius = 12
        card.layer.shadowOffset = CGSize(width: 0, height: 4)
        snapshot.frame = CGRect(origin: .zero, size: frame.size)
        card.addSubview(snapshot)
        dropLine = UIView(
            frame: CGRect(
                x: dropLineX.lowerBound, y: 0,
                width: dropLineX.upperBound - dropLineX.lowerBound, height: 3))
        dropLine.backgroundColor = accent
        dropLine.layer.cornerRadius = 1.5
        dropLine.isHidden = true
        for view in [dim, dropLine, card] {
            view.isUserInteractionEnabled = false
            host.addSubview(view)
        }
        home = card.center
    }

    /// The finger moved to `p`: the card follows it and the drop line moves to the nearest slot.
    func follow(_ p: CGPoint) {
        card.center = CGPoint(x: home.x + p.x - start.x, y: home.y + p.y - start.y)
        let nearest = targets.slot(nearest: p.y)
        slot = nearest?.offset
        dropLine.isHidden = nearest == nil
        if let nearest { dropLine.center.y = nearest.y }
    }

    /// Take everything down; a card that did not land first slides back to where it was lifted.
    func finish(returning: Bool) {
        dropLine.removeFromSuperview()
        guard returning else {
            card.removeFromSuperview()
            dim.removeFromSuperview()
            return
        }
        UIView.animate(
            withDuration: 0.2, animations: { [card, home] in card.center = home },
            completion: { [card, dim] _ in
                card.removeFromSuperview()
                dim.removeFromSuperview()
            })
    }
}

extension TextFirstEditorController {
    func installBlockDrag() {
        let lift = UILongPressGestureRecognizer(target: self, action: #selector(handleLift(_:)))
        lift.minimumPressDuration = TextFirstLiftPolicy.holdDuration
        lift.allowableMovement = TextFirstLiftPolicy.movementTolerance
        lift.delegate = self
        textView.addGestureRecognizer(lift)
        liftRecognizer = lift
    }

    /// The UTF-16 display range of the block a long-press at `p` (text view coordinates) lifts;
    /// nil when the press keeps the platform's long-press: a blank line, an empty note, front
    /// matter, code nothing closes, or anything `TextFirstLiftPolicy` rules out.
    func liftableBlock(at p: CGPoint) -> NSRange? {
        guard
            TextFirstLiftPolicy.mayLift(
                editorReady: !closed && !engineBusy, cellOpen: cellEditor != nil,
                keyboardUp: textView.isFirstResponder),
            let offset = lineOffset(at: p)
        else { return nil }
        do {
            let at = EditorDisplayByteOffset(offset: try mirror.utf16ToByte(unit: UInt64(offset)))
            guard let block = try session.blockAt(expected: rev, at: at) else { return nil }
            let start = Int(try mirror.byteToUtf16(byte: block.start))
            let end = Int(try mirror.byteToUtf16(byte: block.end))
            return NSRange(location: start, length: end - start)
        } catch {
            return nil
        }
    }

    /// The UTF-16 offset of the line at `p`'s height, anywhere across the page (its margins
    /// too); the display's end on the note's empty last line. Nil off the text.
    private func lineOffset(at p: CGPoint) -> Int? {
        guard let manager = textView.textLayoutManager,
            let f = manager.textLayoutFragment(for: CGPoint(x: 1, y: p.y - inset.top))
        else { return nil }
        let local = p.y - inset.top - f.layoutFragmentFrame.minY
        // The empty last line lays out as a zero-length line at the end of the last paragraph.
        if let last = f.textLineFragments.last, last.characterRange.length == 0,
            f.textLineFragments.count > 1, local >= last.typographicBounds.minY
        {
            return storage.length
        }
        return manager.offset(from: manager.documentRange.location, to: f.rangeInElement.location)
    }

    /// The y (text view coordinates) of the boundary at UTF-16 `offset`: the top of the line
    /// that starts there, or the bottom of the last line for the display's end. Nil off screen,
    /// where asking would lay out text the viewport does not show.
    private func boundaryY(_ offset: Int) -> CGFloat? {
        guard let manager = textView.textLayoutManager,
            let content = manager.textContentManager,
            let viewport = manager.textViewportLayoutController.viewportRange
        else { return nil }
        let begin = manager.documentRange.location
        let shown =
            manager.offset(
                from: begin, to: viewport.location)...manager.offset(
                from: begin, to: viewport.endLocation)
        guard shown.contains(offset) else { return nil }
        let atEnd = offset >= storage.length
        guard storage.length > 0,
            let location = content.location(begin, offsetBy: atEnd ? storage.length - 1 : offset),
            let f = manager.textLayoutFragment(for: location)
        else { return nil }
        let top = inset.top + f.layoutFragmentFrame.minY
        guard atEnd else { return top }
        let text = f.textLineFragments.last { $0.characterRange.length > 0 }
        return top + (text?.typographicBounds.maxY ?? f.layoutFragmentFrame.height)
    }

    /// Where the block the line at UTF-16 `line` lifts (`block`) may land on screen.
    func dropTargets(line: Int, block: NSRange) -> TextFirstDropTargets? {
        guard let top = boundaryY(block.location), let bottom = boundaryY(NSMaxRange(block)),
            let slots = try? blockSlots(atLineOffset: line)
        else { return nil }
        return TextFirstDropTargets(
            slots: slots.compactMap { slot in boundaryY(slot).map { (slot, $0) } },
            ownEdges: [top, bottom])
    }

    @objc func handleLift(_ g: UILongPressGestureRecognizer) {
        let p = g.location(in: textView)
        switch g.state {
        case .began:
            beginBlockDrag(at: p)
        case .changed:
            blockDrag?.follow(p)
        case .ended:
            endBlockDrag(dropping: true)
        default:
            endBlockDrag(dropping: false)
        }
    }

    private func beginBlockDrag(at p: CGPoint) {
        // A composition is settled at the lift, so the offsets below are the engine's.
        finishComposition()
        guard let block = liftableBlock(at: p), let line = lineOffset(at: p),
            let targets = dropTargets(line: line, block: block),
            let top = targets.ownEdges.first, let bottom = targets.ownEdges.last
        else { return }
        let frame = CGRect(x: 0, y: top, width: textView.bounds.width, height: bottom - top)
        guard
            let snapshot = textView.resizableSnapshotView(
                from: frame, afterScreenUpdates: false, withCapInsets: .zero)
        else { return }
        // The lift takes the touch: scrolling stops for the drag and every other recognizer on
        // the note (UIKit's selection, loupe and caret taps, the checkbox tap) stands down.
        textView.panGestureRecognizer.isEnabled = false
        for other in textView.gestureRecognizers ?? []
        where other !== liftRecognizer && other !== textView.panGestureRecognizer
            && !(other is TextFirstTouchTracker) && other.isEnabled
        {
            other.isEnabled = false
            other.isEnabled = true
        }
        blockDrag = TextFirstBlockDrag(
            line: line, block: block, targets: targets, start: p, frame: frame,
            snapshot: snapshot, in: textView, background: UIColor(Theme.background),
            accent: textView.tintColor,
            dropLineX: (inset.left - 6)...(textView.bounds.width - inset.right + 6))
    }

    /// The finger lifted (`dropping`) or the touch was cancelled: move the block to the slot
    /// shown, or return the card when there is none or the engine refuses.
    private func endBlockDrag(dropping: Bool) {
        textView.panGestureRecognizer.isEnabled = true
        guard let drag = blockDrag else { return }
        blockDrag = nil
        var moved = false
        if dropping, let slot = drag.slot {
            do {
                moved = try moveBlock(atLineOffset: drag.line, toSlot: slot)
            } catch {
                recover(error, context: "move block")
            }
        }
        drag.finish(returning: !moved)
    }
}

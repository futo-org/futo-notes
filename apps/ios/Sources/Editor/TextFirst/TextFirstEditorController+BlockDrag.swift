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

    /// How near, in points, a press must be to a selection's handle to be the handle's.
    static let handleReach: CGFloat = 22

    /// Whether a press may lift anything, before the line under it is asked. An editor still
    /// opening, and one with a table cell open, keep the platform's long-press everywhere, and a
    /// press on a selection's handle stays the handle's; the title is another view and never
    /// sees this gesture.
    static func mayLift(
        editorReady: Bool, cellOpen: Bool, keyboardUp: Bool, onSelectionHandle: Bool
    ) -> Bool {
        editorReady && !cellOpen && !onSelectionHandle && !(onlyWhileKeyboardDown && keyboardUp)
    }
}

/// Where a lifted block may land on screen: each of the engine's slots on screen with the y of
/// its boundary, and the y of the block's own top and bottom edges (where they show), where a
/// drop would change nothing.
struct TextFirstDropTargets {
    let slots: [(offset: Int, y: CGFloat)]
    let ownTop: CGFloat
    let ownBottom: CGFloat

    /// The slot nearest `y`; nil when one of the block's own edges is nearer (no drop line, and
    /// a release there returns the card).
    func slot(nearest y: CGFloat) -> (offset: Int, y: CGFloat)? {
        guard let best = slots.min(by: { abs($0.y - y) < abs($1.y - y) }) else { return nil }
        return abs(best.y - y) < min(abs(ownTop - y), abs(ownBottom - y)) ? best : nil
    }
}

/// What a press at a point lifts: the line pressed (its UTF-16 offset), the block it lifts, the
/// card's frame (the block's part on screen) and where it may land, at the engine's revision.
struct TextFirstLift {
    let lineOffset: Int
    let block: NSRange
    let frame: CGRect
    let targets: TextFirstDropTargets
    let revision: UInt64
}

/// One drag in progress: what was lifted and the views drawn for it.
@MainActor
final class TextFirstBlockDrag {
    let lift: TextFirstLift
    /// Where the finger lifted the card, and the card's centre then.
    let start: CGPoint
    let liftedCenter: CGPoint
    let card: UIView
    let dimmedSource: UIView
    let dropLine: UIView
    private(set) var slot: Int?

    init(_ lift: TextFirstLift, at start: CGPoint, snapshot: UIView, on textView: UITextView) {
        (self.lift, self.start) = (lift, start)
        let background = UIColor(Theme.background)
        dimmedSource = UIView(frame: lift.frame)
        dimmedSource.backgroundColor = background.withAlphaComponent(0.65)
        card = UIView(frame: lift.frame)
        // As the old web editor's: only the card's background is see-through, so the lines
        // around the drop line show through while the lifted text stays fully opaque.
        card.backgroundColor = background.withAlphaComponent(0.8)
        card.layer.cornerRadius = 8
        card.layer.shadowColor = UIColor.black.cgColor
        card.layer.shadowOpacity = 0.25
        card.layer.shadowRadius = 12
        card.layer.shadowOffset = CGSize(width: 0, height: 4)
        snapshot.frame = CGRect(origin: .zero, size: lift.frame.size)
        card.addSubview(snapshot)
        let inset = textView.textContainerInset
        dropLine = UIView(
            frame: CGRect(
                x: inset.left - 6, y: 0,
                width: textView.bounds.width - inset.left - inset.right + 12,
                height: 3))
        dropLine.backgroundColor = textView.tintColor
        dropLine.layer.cornerRadius = 1.5
        dropLine.isHidden = true
        // The drop line is drawn over the card (which is under the finger), so it never fades.
        for view in [dimmedSource, card, dropLine] {
            view.isUserInteractionEnabled = false
            textView.addSubview(view)
        }
        liftedCenter = card.center
    }

    /// The finger moved to `p`: the card follows it and the drop line moves to the nearest slot.
    func follow(_ p: CGPoint) {
        card.center = CGPoint(x: liftedCenter.x + p.x - start.x, y: liftedCenter.y + p.y - start.y)
        let nearest = lift.targets.slot(nearest: p.y)
        slot = nearest?.offset
        dropLine.isHidden = nearest == nil
        if let nearest { dropLine.center.y = nearest.y }
    }

    /// Take everything down; a card that did not land first slides back to where it was lifted.
    func finish(returning: Bool) {
        dropLine.removeFromSuperview()
        guard returning else {
            card.removeFromSuperview()
            dimmedSource.removeFromSuperview()
            return
        }
        UIView.animate(
            withDuration: 0.2, animations: { [card, liftedCenter] in card.center = liftedCenter },
            completion: { [card, dimmedSource] _ in
                card.removeFromSuperview()
                dimmedSource.removeFromSuperview()
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
        // UIKit's text drag (a long-press on selected text) holds every other recognizer on the
        // note until the finger moves, which would keep the lift from firing while the finger
        // holds still; a long-press is the block's now.
        textView.textDragInteraction?.isEnabled = false
    }

    /// What a long-press at `p` (text view coordinates) lifts; nil when the press keeps the
    /// platform's long-press: a blank line, an empty note, front matter, code nothing closes, or
    /// anything `TextFirstLiftPolicy` rules out.
    func liftPlan(at p: CGPoint) -> TextFirstLift? {
        guard
            TextFirstLiftPolicy.mayLift(
                editorReady: !closed && !engineBusy, cellOpen: cellEditor != nil,
                keyboardUp: textView.isFirstResponder, onSelectionHandle: onSelectionHandle(p)),
            let line = lineOffset(at: p)
        else { return nil }
        let block: NSRange
        let slots: [Int]
        do {
            guard let found = try blockRange(atLineOffset: line),
                let landing = try blockSlots(atLineOffset: line)
            else { return nil }
            (block, slots) = (found, landing)
        } catch {
            print("text-first: block lookup failed: \(error)")
            return nil
        }
        // What shows: the text view's bounds less what the keyboard covers.
        let insets = textView.adjustedContentInset
        let shown = textView.bounds.inset(
            by: UIEdgeInsets(top: insets.top, left: 0, bottom: insets.bottom, right: 0))
        let top = max(boundaryY(block.location) ?? -.infinity, shown.minY)
        let bottom = min(boundaryY(NSMaxRange(block)) ?? .infinity, shown.maxY)
        guard bottom > top else { return nil }
        let targets = TextFirstDropTargets(
            slots: slots.compactMap { slot in
                boundaryY(slot).flatMap { shown.minY...shown.maxY ~= $0 ? (slot, $0) : nil }
            },
            ownTop: top, ownBottom: bottom)
        return TextFirstLift(
            lineOffset: line, block: block,
            frame: CGRect(x: 0, y: top, width: textView.bounds.width, height: bottom - top),
            targets: targets, revision: rev)
    }

    /// Whether `p` is on a handle of the selection the view shows (its start or end caret,
    /// within `TextFirstLiftPolicy.handleReach`).
    private func onSelectionHandle(_ p: CGPoint) -> Bool {
        guard textView.isFirstResponder, let range = textView.selectedTextRange, !range.isEmpty
        else { return false }
        return [range.start, range.end].contains { end in
            textView.caretRect(for: end).insetBy(
                dx: -TextFirstLiftPolicy.handleReach, dy: -TextFirstLiftPolicy.handleReach
            ).contains(p)
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
    /// that starts there, or the bottom of the last line for the display's end. Nil outside the
    /// laid-out viewport, where asking would lay out text that is not shown.
    private func boundaryY(_ offset: Int) -> CGFloat? {
        guard let manager = textView.textLayoutManager,
            let content = manager.textContentManager,
            let viewport = manager.textViewportLayoutController.viewportRange
        else { return nil }
        let begin = manager.documentRange.location
        let laidOut =
            manager.offset(
                from: begin, to: viewport.location)...manager.offset(
                from: begin, to: viewport.endLocation)
        guard laidOut.contains(offset) else { return nil }
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

    /// The lift decides at its 340 ms whether this press is a block's: it plans the whole drag
    /// then, so a press that cannot show one leaves the platform its long-press.
    func liftShouldBegin(at p: CGPoint) -> Bool {
        guard liftPlan(at: p) != nil else { return false }
        // A composition is settled at the lift; the plan is then made on the settled text.
        finishComposition()
        pendingLift = liftPlan(at: p)
        return pendingLift != nil
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
        guard let lift = pendingLift else { return }
        pendingLift = nil
        let snapshot =
            textView.resizableSnapshotView(
                from: lift.frame, afterScreenUpdates: false, withCapInsets: .zero) ?? UIView()
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
        // An edit menu left from an earlier press points at a selection the drag is not about.
        for case let menu as UIEditMenuInteraction in textView.interactions { menu.dismissMenu() }
        blockDrag = TextFirstBlockDrag(lift, at: p, snapshot: snapshot, on: textView)
    }

    /// The finger lifted (`dropping`) or the touch was cancelled: move the block to the slot
    /// shown, or return the card when there is none, the note changed since the lift (the
    /// offsets would name other text) or the engine refuses.
    private func endBlockDrag(dropping: Bool) {
        textView.panGestureRecognizer.isEnabled = true
        pendingLift = nil
        guard let drag = blockDrag else { return }
        blockDrag = nil
        var moved = false
        if dropping, let slot = drag.slot, drag.lift.revision == rev {
            do {
                moved = try moveBlock(atLineOffset: drag.lift.lineOffset, toSlot: slot)
            } catch {
                recover(error, context: "move block")
            }
        }
        drag.finish(returning: !moved)
    }
}

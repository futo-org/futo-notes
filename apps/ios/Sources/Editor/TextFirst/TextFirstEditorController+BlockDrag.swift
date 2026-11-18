import UIKit

// Long-press block drag (#441; #311 holds the design). With the keyboard down, a press that
// holds still lifts what the engine says a press at the position under the finger lifts (a
// photo sharing its line alone, else the line's block): a snapshot card of it follows the
// finger, the source dims in place, a drop line marks the engine's slot nearest the finger,
// and releasing moves it there as one Undo step (+BlockMove). While the note is being edited
// every long-press is the platform's, as in the web editor. The view decides only which
// position is under the finger and which slot is nearest.

/// How a press lifts a block: the old web editor's hold and tolerance.
enum TextFirstLiftPolicy {
    /// How long a press holds before it lifts.
    static let holdDuration: TimeInterval = 0.34
    /// How far, in points, the finger may wander while it holds.
    static let movementTolerance: CGFloat = 10
}

/// The drag's feel, as the web editor's iOS host gave it: an impact at the lift, a selection
/// tick each time the drop line reaches a new slot, and a lighter impact when the block lands.
/// A card that returns lands nothing and is silent.
@MainActor
final class TextFirstDragHaptics {
    private let lift = UIImpactFeedbackGenerator(style: .medium)
    private let tick = UISelectionFeedbackGenerator()
    private let drop = UIImpactFeedbackGenerator(style: .light)

    /// A press that may lift has begun: have the lift's impact ready when the hold ends.
    func prepareLift() { lift.prepare() }
    func lifted() {
        lift.impactOccurred()
        tick.prepare()
        drop.prepare()
    }
    func reachedSlot() {
        tick.selectionChanged()
        tick.prepare()
    }
    func landed() { drop.impactOccurred() }
}

/// Where a lifted block may land on screen: each of the engine's slots on screen with the y of
/// its boundary, and the y of the block's own top and bottom edges (where they show), where a
/// drop would change nothing. A lifted photo has no such edge (every slot moves it, its own
/// line's edges too), so both are its middle: held where it was, it drops nowhere.
struct TextFirstDropTargets {
    let slots: [(slot: TextFirstBlockSlot, y: CGFloat)]
    let ownTop: CGFloat
    let ownBottom: CGFloat

    /// The slot nearest `y`; nil when one of the block's own edges is nearer (no drop line, and
    /// a release there returns the card).
    func slot(nearest y: CGFloat) -> (slot: TextFirstBlockSlot, y: CGFloat)? {
        guard let best = slots.min(by: { abs($0.y - y) < abs($1.y - y) }) else { return nil }
        return abs(best.y - y) < min(abs(ownTop - y), abs(ownBottom - y)) ? best : nil
    }
}

/// What a press at a point lifts: the position pressed (its UTF-16 offset), the block it lifts,
/// the card's frame (the block's part on screen, or the photo) and where it may land among the
/// slots near the screen, at the engine's revision.
struct TextFirstLift {
    let offset: Int
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
    private(set) var slot: TextFirstBlockSlot?

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
    /// True when the drop line reached a slot it was not on (after showing none, any slot).
    @discardableResult func follow(_ p: CGPoint) -> Bool {
        card.center = CGPoint(x: liftedCenter.x + p.x - start.x, y: liftedCenter.y + p.y - start.y)
        let nearest = lift.targets.slot(nearest: p.y)
        let previous = slot
        slot = nearest?.slot
        dropLine.isHidden = nearest == nil
        if let nearest { dropLine.center.y = nearest.y }
        return slot != nil && slot != previous
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
        stockTextDrag = textView.textDragInteraction?.isEnabled ?? false
        armLift()
    }

    /// Whether a press may lift anything, before the line under it is asked: not while the
    /// note is being edited, nor while the editor is still opening or has closed.
    var mayLift: Bool { !closed && !engineBusy && !editing }

    /// The note is being edited: a field of the screen takes the keyboard, the on-screen one or
    /// a hardware one alike. That is the body, an open table cell, or any other text input in
    /// the editor's window (the title, Find).
    private var editing: Bool {
        if textView.isFirstResponder || cellEditor != nil { return true }
        func focused(_ view: UIView) -> Bool {
            (view.isFirstResponder && view is UITextInput) || view.subviews.contains(where: focused)
        }
        return textView.window.map(focused) ?? false
    }

    /// Settle, as a touch comes down on the note and before any recognizer sees it, whether this
    /// press is one that may lift (`liftArmed`, as `mayLift` says). Only then does
    /// the lift take the long-press: UIKit's long-presses wait for it to fail, and UIKit's text
    /// drag (which holds every other recognizer on the note until the finger moves) is off.
    /// Otherwise the press is the platform's alone, its text drag as UIKit set it.
    func armLift() {
        liftArmed = mayLift
        textView.textDragInteraction?.isEnabled = !liftArmed && stockTextDrag
        if liftArmed { dragHaptics.prepareLift() }
    }

    /// The lift decides at its 340 ms whether this press is a block's: it plans the whole drag
    /// then, so a press that cannot show one leaves the platform its long-press.
    func liftShouldBegin(at p: CGPoint) -> Bool {
        pendingLift = liftPlan(at: p)
        return pendingLift != nil
    }

    @objc func handleLift(_ g: UILongPressGestureRecognizer) {
        let p = g.location(in: textView)
        switch g.state {
        case .began:
            beginBlockDrag(at: p)
        case .changed:
            followBlockDrag(to: p)
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
        dragHaptics.lifted()
    }

    private func followBlockDrag(to p: CGPoint) {
        if blockDrag?.follow(p) == true { dragHaptics.reachedSlot() }
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
                moved = try moveBlock(at: drag.lift.offset, to: slot)
            } catch {
                recover(error, context: "move block")
            }
        }
        if moved { dragHaptics.landed() }
        drag.finish(returning: !moved)
    }
}

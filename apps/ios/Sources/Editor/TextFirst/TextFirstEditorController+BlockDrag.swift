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

/// What a press at a point lifts, at the engine's revision: its slots, kept as the note scrolls
/// (`book`), the card's frame (the block's part on screen, or the photo) and where it may land
/// as the note was drawn at the lift.
struct TextFirstLift {
    var book: TextFirstSlotBook
    let frame: CGRect
    let targets: TextFirstDropTargets
    /// The position pressed (UTF-16), by which the engine names the block, and the block.
    var offset: Int { book.offset }
    var block: NSRange { book.block.range }
    var revision: UInt64 { book.revision }
}

/// One drag in progress: what was lifted, where it may land as drawn now, and the views drawn for
/// it. The card and the drop line live in the note's content, so they are placed again whenever
/// the note scrolls; the finger is kept on screen, where it stays while the note scrolls under it.
@MainActor
final class TextFirstBlockDrag {
    let lift: TextFirstLift
    var book: TextFirstSlotBook
    private(set) var targets: TextFirstDropTargets
    /// Where the finger lifted the card and the card's centre then (text view coordinates).
    let start: CGPoint
    let liftedCenter: CGPoint
    /// The finger now, on screen: text view coordinates less the scroll.
    private var finger: CGPoint
    let card: UIView
    let dimmedSource: UIView
    let dropLine: UIView
    let autoscroller: TextFirstAutoscroller
    private(set) var slot: TextFirstBlockSlot?
    /// `targets` are being read (reading lays text out, which can ask again).
    var measuring = false
    private weak var textView: UITextView?

    init(
        _ lift: TextFirstLift, at start: CGPoint, snapshot: UIView, on textView: UITextView,
        autoscroll: @escaping (CGFloat) -> Void = { _ in }
    ) {
        (self.lift, book, targets, self.start, self.textView) =
            (lift, lift.book, lift.targets, start, textView)
        let scrolled = textView.contentOffset
        finger = CGPoint(x: start.x - scrolled.x, y: start.y - scrolled.y)
        autoscroller = TextFirstAutoscroller(autoscroll)
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
        dropLine = UIView(frame: CGRect(x: 0, y: 0, width: 0, height: 3))
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

    /// The finger moved to `p` (text view coordinates): the card follows it and the drop line
    /// moves to the nearest slot. True when the drop line reached a slot it was not on (after
    /// showing none, any slot).
    @discardableResult func follow(_ p: CGPoint) -> Bool {
        let scrolled = textView?.contentOffset ?? .zero
        finger = CGPoint(x: p.x - scrolled.x, y: p.y - scrolled.y)
        let previous = slot
        place()
        return slot != nil && slot != previous
    }

    /// The note scrolled or was laid out again under a still finger: `targets` are where things
    /// are drawn now. The drop line may change slot; that is not the finger's doing, so no tick.
    func remeasured(_ targets: TextFirstDropTargets) {
        self.targets = targets
        place()
    }

    /// The finger's y in text view coordinates.
    var fingerY: CGFloat { finger.y + (textView?.contentOffset.y ?? 0) }

    /// Keep the card under the finger, the dimmed place on the block and the drop line on the
    /// slot nearest the finger, as drawn now.
    private func place() {
        guard let textView else { return }
        let scrolled = textView.contentOffset
        card.center = CGPoint(
            x: liftedCenter.x - start.x + finger.x + scrolled.x,
            y: liftedCenter.y - start.y + finger.y + scrolled.y)
        dimmedSource.isHidden = targets.source == nil
        if let source = targets.source { dimmedSource.frame = source }
        let inset = textView.textContainerInset
        dropLine.frame.origin.x = inset.left - 6
        dropLine.frame.size.width = textView.bounds.width - inset.left - inset.right + 12
        let nearest = targets.slot(nearest: fingerY)
        slot = nearest?.slot
        dropLine.isHidden = nearest == nil
        if let nearest { dropLine.center.y = nearest.y }
    }

    /// Take everything down; a card that did not land first slides back to where it was lifted.
    func finish(returning: Bool) {
        autoscroller.stop()
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
            // iOS took the touch (a call, the app going to the background): nothing moves.
            endBlockDrag(dropping: false)
        }
    }

    func beginBlockDrag(at p: CGPoint) {
        guard let lift = pendingLift, lift.revision == rev else { return }
        pendingLift = nil
        let snapshot =
            textView.resizableSnapshotView(
                from: lift.frame, afterScreenUpdates: false, withCapInsets: .zero) ?? UIView()
        // The lift takes the touch: the finger no longer scrolls the note (the edge autoscroll
        // does) and every other recognizer on the note (UIKit's selection, loupe and caret
        // taps, the checkbox tap) stands down.
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
        blockDrag = TextFirstBlockDrag(
            lift, at: p, snapshot: snapshot, on: textView,
            autoscroll: { [weak self] step in self?.autoscrollBlockDrag(by: step) })
        dragHaptics.lifted()
    }

    func followBlockDrag(to p: CGPoint) {
        guard let drag = blockDrag else { return }
        if drag.follow(p) { dragHaptics.reachedSlot() }
        let insets = textView.adjustedContentInset
        let bounds = textView.bounds
        drag.autoscroller.velocity = TextFirstAutoscroll.velocity(
            at: p.y, in: (bounds.minY + insets.top)...(bounds.maxY - insets.bottom))
    }

    /// One autoscroll frame: scroll by `step`, held to the note's ends, and read the targets
    /// again from the layout that scrolled into view. The finger has not moved: no tick.
    private func autoscrollBlockDrag(by step: CGFloat) {
        guard blockDrag != nil else { return }
        let insets = textView.adjustedContentInset
        let top = -insets.top
        let bottom = max(
            top, textView.contentSize.height + insets.bottom - textView.bounds.height)
        let from = textView.contentOffset.y
        let to = min(max(from + step, top), bottom)
        guard to != from else { return }
        textView.contentOffset.y = to
        textView.layoutIfNeeded()
        remeasureBlockDrag()
    }

    /// The note was laid out again (a scroll, a photo that decoded, a rotation): the drag's
    /// targets are read again from where things are drawn now, and the drag carries on.
    func remeasureBlockDrag() {
        guard let drag = blockDrag, !drag.measuring else { return }
        drag.measuring = true
        defer { drag.measuring = false }
        do {
            drag.remeasured(try dropTargets(&drag.book))
        } catch {
            print("text-first: drop targets failed: \(error)")
            cancelBlockDrag()
        }
    }

    /// The finger lifted (`dropping`) or iOS cancelled the touch: move the block to the slot
    /// shown, or return the card when there is none or the engine refuses.
    func endBlockDrag(dropping: Bool) {
        pendingLift = nil
        guard let drag = takeBlockDrag() else { return }
        var moved = false
        if dropping, let slot = drag.slot, drag.lift.revision == rev {
            let held = leavesFromAboveTheScreen(drag, to: slot) ? lineAbove(slot, drag) : nil
            do {
                moved = try moveBlock(at: drag.lift.offset, to: slot)
            } catch {
                recover(error, context: "move block")
            }
            if moved, let held { holdStill(held) }
        }
        if moved { dragHaptics.landed() }
        drag.finish(returning: !moved)
    }

    /// Whether `drag` drops its block below the screen's top while the block starts above it:
    /// taking it out there would pull everything on screen up by its height.
    private func leavesFromAboveTheScreen(_ drag: TextFirstBlockDrag, to slot: TextFirstBlockSlot)
        -> Bool
    {
        let shownTop = textView.bounds.minY + textView.adjustedContentInset.top
        return drag.lift.block.location < slot.offset
            && (drag.targets.source.map { $0.minY <= shownTop + 0.5 } ?? true)
    }

    /// The line drawn just above the drop line at `slot`, as the drop will leave it: the middle
    /// of its text once `drag`'s block, above it, has moved there (it moves up by the block's
    /// length; arrival changes shift it by a few units at most), and its top now on screen. Nil
    /// when TextKit has not laid that line out.
    private func lineAbove(_ slot: TextFirstBlockSlot, _ drag: TextFirstBlockDrag)
        -> (middle: Int, top: CGFloat)?
    {
        guard let laidOut = laidOutRange() else { return nil }
        let line = (storage.string as NSString).lineRange(
            for: NSRange(location: slot.offset - 1, length: 0))
        let start = TextFirstBlockSlot(offset: line.location, end: false)
        guard let top = boundaryY(start, in: laidOut)
        else { return nil }
        return (
            line.location + line.length / 2 - drag.lift.block.length,
            top - textView.contentOffset.y
        )
    }

    /// Scroll so the line `held` names is back where it was drawn: what the move took out above
    /// the screen does not make the note jump at the drop.
    private func holdStill(_ held: (middle: Int, top: CGFloat)) {
        textView.layoutIfNeeded()
        let text = storage.string as NSString
        guard text.length > 0, let laidOut = laidOutRange() else { return }
        let line = text.lineRange(
            for: NSRange(location: min(max(held.middle, 0), text.length - 1), length: 0))
        let start = TextFirstBlockSlot(offset: line.location, end: false)
        guard let top = boundaryY(start, in: laidOut)
        else { return }
        let insets = textView.adjustedContentInset
        let lowest = max(
            -insets.top, textView.contentSize.height + insets.bottom - textView.bounds.height)
        let y = min(max(top - held.top, -insets.top), lowest)
        if abs(y - textView.contentOffset.y) > 0.25 { textView.contentOffset.y = y }
    }

    /// End the drag in progress with nothing moved, the finger still down or not. The card,
    /// the drop line and the dim go at once, silently, and the press is over: nothing the
    /// finger does until it lifts is a drag.
    func cancelBlockDrag() {
        guard let drag = takeBlockDrag() else { return }
        drag.finish(returning: false)
        liftRecognizer?.isEnabled = false
        liftRecognizer?.isEnabled = true
    }

    private func takeBlockDrag() -> TextFirstBlockDrag? {
        textView.panGestureRecognizer.isEnabled = true
        guard let drag = blockDrag else { return nil }
        blockDrag = nil
        drag.autoscroller.stop()
        return drag
    }
}

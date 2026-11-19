import UIKit

// Long-press block drag (#441; #311 holds the design). With the keyboard down, a press that
// holds still lifts what the engine says a press at the position under the finger lifts (a
// photo sharing its line alone, else the line's block): a card of it follows the finger and the
// note shows the move live (+BlockPreview, #448): the block's place closes, a gap opens where it
// would land and the blocks between slide. With Reduce Motion on, once the note autoscrolls, or
// when the preview cannot be built, the block dims in place and a drop line marks the slot
// instead. Releasing moves it there as one Undo step (+BlockMove). While the note is being edited
// every long-press is the platform's, as in the web editor. The view decides only which
// position is under the finger and which slot it chooses.

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
/// it. The card, the drop line and the preview live in the note's content, so they are placed
/// again whenever the note scrolls; the finger is kept on screen, where it stays while the note
/// scrolls under it.
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
    /// The live preview, while the drag shows one instead of the drop line; why it could not
    /// be built, when it could not.
    var preview: TextFirstReflow?
    var previewUnavailable: String?
    private(set) var slot: TextFirstBlockSlot?
    /// `targets` are being read (reading lays text out, which can ask again).
    var measuring = false
    private weak var textView: UITextView?

    init(
        _ lift: TextFirstLift, at start: CGPoint, card: UIView, on textView: UITextView,
        autoscroll: @escaping (CGFloat) -> Bool = { _ in false }
    ) {
        (self.lift, book, targets, self.start, self.card, self.textView) =
            (lift, lift.book, lift.targets, start, card, textView)
        let scrolled = textView.contentOffset
        finger = CGPoint(x: start.x - scrolled.x, y: start.y - scrolled.y)
        autoscroller = TextFirstAutoscroller(autoscroll)
        // The block's place at 35%: the surface colour at 65% over it.
        dimmedSource = UIView(frame: lift.frame)
        dimmedSource.backgroundColor = UIColor(Theme.background).withAlphaComponent(0.65)
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
        autoscroller.meter.runs = { [weak self] in self?.preview?.plan.runs.count ?? 0 }
    }

    /// The finger moved to `p` (text view coordinates): the card follows it, and the preview's
    /// gap or the drop line moves. True when the gap moved to a slot, or the drop line reached a
    /// slot it was not on (after showing none, any slot).
    @discardableResult func follow(_ p: CGPoint) -> Bool {
        let scrolled = textView?.contentOffset ?? .zero
        finger = CGPoint(x: p.x - scrolled.x, y: p.y - scrolled.y)
        if let preview {
            let ticked = preview.follow(fingerY)
            place()
            return ticked
        }
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

    /// Keep the card under the finger, the dimmed place on the block (until the preview's
    /// curtain covers it) and the drop line on the slot nearest the finger, as drawn now.
    func place() {
        guard let textView else { return }
        let scrolled = textView.contentOffset
        card.center = CGPoint(
            x: liftedCenter.x - start.x + finger.x + scrolled.x,
            y: liftedCenter.y - start.y + finger.y + scrolled.y)
        dimmedSource.isHidden = targets.source == nil || preview?.isOpen == true
        if let source = targets.source { dimmedSource.frame = source }
        if let preview {
            dropLine.isHidden = true
            slot = preview.slot
            return
        }
        let inset = textView.textContainerInset
        dropLine.frame.origin.x = inset.left - 6
        dropLine.frame.size.width = textView.bounds.width - inset.left - inset.right + 12
        let nearest = targets.slot(nearest: fingerY)
        slot = nearest?.slot
        dropLine.isHidden = nearest == nil
        if let nearest { dropLine.center.y = nearest.y }
    }

    /// A drag its editor let go of without finishing it (the editor went away while its view
    /// stayed) takes itself off the view.
    isolated deinit {
        guard !finished else { return }
        for view in [card, dimmedSource, dropLine] { view.removeFromSuperview() }
        preview?.remove()
        textView?.panGestureRecognizer.isEnabled = true
    }

    private var finished = false

    /// The drop's landing takes over what is still drawn (the preview, the dim).
    func handOffToLanding() {
        finished = true
        autoscroller.stop()
    }

    /// Take everything down; a card that did not land first slides back to where it was lifted.
    func finish(returning: Bool) {
        finished = true
        autoscroller.stop()
        dropLine.removeFromSuperview()
        preview?.remove()
        guard returning else {
            card.removeFromSuperview()
            dimmedSource.removeFromSuperview()
            return
        }
        // Onto the block where it is drawn now (a photo above it may have loaded since the
        // lift); where it was lifted when it no longer shows.
        let home = targets.source.map { CGPoint(x: liftedCenter.x, y: $0.midY) } ?? liftedCenter
        UIView.animate(
            withDuration: 0.2, animations: { [card, home] in card.center = home },
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
        // An incoming call or a switch away resigns the app's activity before any touch is
        // cancelled: a drag ends there, with nothing moved.
        NotificationCenter.default.addObserver(
            self, selector: #selector(blockDragInterrupted),
            name: UIApplication.willResignActiveNotification, object: nil)
    }

    /// Whether a press may lift anything, before the line under it is asked: not while the
    /// note is being edited, nor while the editor is still opening or has closed.
    var mayLift: Bool {
        !closed && !engineBusy && !editing && outsideChangesPending == 0 && reflowLanding == nil
    }

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
        let card = blockCard(lift, finger: p)
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
        let drag = TextFirstBlockDrag(
            lift, at: p, card: card, on: textView,
            autoscroll: { [weak self] step in self?.autoscrollBlockDrag(by: step) ?? false })
        blockDrag = drag
        TextFirstBlockCard.lift(card)
        startPreview(drag)
        dragHaptics.lifted()
        steerAutoscroll()
    }

    func followBlockDrag(to p: CGPoint) {
        guard let drag = blockDrag else { return }
        if drag.follow(p) { dragHaptics.reachedSlot() }
        steerAutoscroll()
    }

    /// Set the autoscroll's speed from where the finger is in what shows of the note: at the
    /// lift, as the finger moves, and as the visible area changes under a still finger.
    /// The live preview scrolls with the note (#449).
    func steerAutoscroll() {
        guard let drag = blockDrag else { return }
        let insets = textView.adjustedContentInset
        let bounds = textView.bounds
        let velocity = TextFirstAutoscroll.velocity(
            at: drag.fingerY, in: (bounds.minY + insets.top)...(bounds.maxY - insets.bottom))
        drag.autoscroller.velocity = velocity
        drag.autoscroller.resume()
    }

    /// One autoscroll frame: scroll by `step`, held to the note's ends, and read the targets
    /// again from the layout that scrolled into view. The finger has not moved: no tick. False
    /// when the note is at that end.
    private func autoscrollBlockDrag(by step: CGFloat) -> Bool {
        guard blockDrag != nil else { return false }
        let (top, bottom) = scrollEnds
        let from = textView.contentOffset.y
        let to = min(max(from + step, top), bottom)
        guard to != from else { return false }
        textView.contentOffset.y = to
        textView.layoutIfNeeded()
        remeasureBlockDrag()
        return true
    }

    /// The lowest and highest scroll offsets the note has, its foot as far down as the preview
    /// draws it (a block can take more room in a gap than it leaves: a photo lifted out of a
    /// row it shared), so the note's end stays within reach.
    private var scrollEnds: (top: CGFloat, bottom: CGFloat) {
        let insets = textView.adjustedContentInset
        let top = -insets.top
        let grows = blockDrag?.preview.map { $0.plan.grows($0.gap) } ?? 0
        return (
            top,
            max(top, textView.contentSize.height + grows + insets.bottom - textView.bounds.height)
        )
    }

    /// The note was laid out again (a scroll, a photo that decoded, a rotation): the drag's
    /// targets are read again from where things are drawn now, and the drag carries on.
    func remeasureBlockDrag() {
        // A drop still settling is drawn for the layout it settled into: any other ends it.
        if let landing = reflowLanding, landing.disturbed(textView) { finishLanding() }
        guard let drag = blockDrag, !drag.measuring else { return }
        drag.measuring = true
        defer { drag.measuring = false }
        do {
            drag.remeasured(try dropTargets(&drag.book))
            if let preview = drag.preview { remeasurePreview(drag, preview) }
            steerAutoscroll()
        } catch {
            print("text-first: drop targets failed: \(error)")
            cancelBlockDrag()
        }
    }

    /// End the drag in progress with nothing moved, the finger still down or not: the note's
    /// text changed under it, the app is leaving the foreground, or the note closed. The card,
    /// the preview, the drop line and the dim go at once, silently, and the press is over:
    /// nothing the finger does until it lifts is a drag. A drop still settling comes down at once.
    func cancelBlockDrag() {
        finishLanding()
        guard let drag = takeBlockDrag() else { return }
        drag.finish(returning: false)
        liftRecognizer?.isEnabled = false
        liftRecognizer?.isEnabled = true
    }

    /// A sync wrote this note on disk: take it in with a checkpoint. Until that has run (it
    /// waits its turn on the I/O queue) the editor and the engine still agree on the old text,
    /// so a drag ends now and no block lifts or drops before the new text is in.
    func noteChangedOutside() {
        cancelBlockDrag()
        outsideChangesPending += 1
        checkpoint { [weak self] in self?.outsideChangesPending -= 1 }
    }

    /// The note's revision moved: a drag lifted at another revision ends.
    func noteRevisionChanged() {
        if let drag = blockDrag, drag.lift.revision != rev { cancelBlockDrag() }
        if let landing = reflowLanding, landing.revision != rev { finishLanding() }
    }

    @objc func blockDragInterrupted() { cancelBlockDrag() }

    func takeBlockDrag() -> TextFirstBlockDrag? {
        textView.panGestureRecognizer.isEnabled = true
        guard let drag = blockDrag else { return nil }
        blockDrag = nil
        drag.autoscroller.stop()
        return drag
    }
}

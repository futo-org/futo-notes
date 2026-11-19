import UIKit

// The release of a block drag shown with the drop line (#311, #443): the block lands on the slot
// the drop line shows, as one Undo step, and a block that left from above the screen does not
// pull the screen up with it. A previewed drag lands in +BlockLanding.

extension TextFirstEditorController {
    /// The finger lifted (`dropping`) or iOS cancelled the touch: move the block to the slot
    /// shown, or return the card when there is none or the engine refuses.
    func endBlockDrag(dropping: Bool) {
        pendingLift = nil
        guard let drag = takeBlockDrag() else { return }
        if let preview = drag.preview { return landPreview(drag, preview, dropping: dropping) }
        var moved = false
        if dropping, outsideChangesPending == 0, let slot = drag.slot, drag.lift.revision == rev {
            let held = heldLine(drag, to: slot)
            do {
                moved = try moveBlock(at: drag.lift.offset, to: slot)
            } catch {
                recover(error, context: "move block")
            }
            if moved, let held {
                holdStill(held)
                // TextKit settles what it estimated above the screen on its next pass.
                let settled = rev
                DispatchQueue.main.async { [weak self] in
                    MainActor.assumeIsolated {
                        if let self, self.rev == settled, self.blockDrag == nil {
                            self.holdStill(held)
                        }
                    }
                }
            }
        }
        if moved { dragHaptics.landed() }
        liftedLayout = nil
        drag.finish(returning: !moved)
    }

    /// The line to hold still on screen when `drag` drops its block at `slot`: only a block that
    /// leaves from above the screen to land below its top needs one, since taking it out pulls
    /// everything on screen up by its height. It is a line shown below the block and above
    /// the drop line: the move shifts it up by exactly the block's length (a renumbered
    /// marker above it by a unit or two, so its middle is what is kept). The middle of its text
    /// after the move, and its top on screen now.
    private func heldLine(_ drag: TextFirstBlockDrag, to slot: TextFirstBlockSlot)
        -> (middle: Int, top: CGFloat)?
    {
        let block = drag.lift.block
        let shownTop = textView.bounds.minY + textView.adjustedContentInset.top
        guard block.location < slot.offset,
            drag.targets.source.map({ $0.minY <= shownTop + 0.5 }) ?? true,
            let manager = textView.textLayoutManager, let laidOut = laidOutRange(),
            let shown = manager.textLayoutFragment(
                for: CGPoint(x: 0, y: shownTop - textView.textContainerInset.top))
        else { return nil }
        let text = storage.string as NSString
        // The first line starting at or after the block's end (a photo lifted out of its line
        // ends inside that line), and not above the screen.
        var start = NSMaxRange(block)
        if start > 0, start < text.length, text.character(at: start - 1) != 0x0A {
            start = NSMaxRange(text.noteLine(at: start))
        }
        start = max(
            start,
            manager.offset(from: manager.documentRange.location, to: shown.rangeInElement.location))
        guard start < slot.offset else { return nil }
        // The line just above the slot, where the eye is, when it shows whole; else the first
        // line that shows. A line cut by the screen's top edge is where TextKit joins its
        // estimate of the text above the screen to what it lays out, and holding it held the
        // estimate, not the screen (the screen moved by 8 pt).
        let above = text.noteLine(at: max(start, slot.offset - 1))
        let held = above.location >= start ? above.location : start
        guard let top = boundaryY(TextFirstBlockSlot(offset: held, end: false), in: laidOut)
        else { return nil }
        let line = text.noteLine(at: held)
        return (line.location + line.length / 2 - block.length, top - textView.contentOffset.y)
    }

    /// Scroll so the line `held` names is back where it was drawn, laying it out wherever the
    /// move left it (a block taller than the screen leaves it screens above the old view).
    private func holdStill(_ held: (middle: Int, top: CGFloat)) {
        textView.layoutIfNeeded()
        let text = storage.string as NSString
        guard text.length > 0, let manager = textView.textLayoutManager,
            let content = manager.textContentManager
        else { return }
        let line = text.noteLine(at: min(max(held.middle, 0), text.length - 1))
        guard
            let location = content.location(
                manager.documentRange.location, offsetBy: line.location),
            let end = content.location(location, offsetBy: 1),
            let range = NSTextRange(location: location, end: end)
        else { return }
        manager.ensureLayout(for: range)
        guard let fragment = manager.textLayoutFragment(for: location) else { return }
        let top = textView.textContainerInset.top + fragment.layoutFragmentFrame.minY
        let insets = textView.adjustedContentInset
        let lowest = max(
            -insets.top, textView.contentSize.height + insets.bottom - textView.bounds.height)
        let y = min(max(top - held.top, -insets.top), lowest)
        if abs(y - textView.contentOffset.y) > 0.25 { textView.contentOffset.y = y }
    }
}

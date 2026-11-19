import UIKit

// The release of a previewed block drag (#448). The card goes at once and the copy in the gap
// turns solid; the move is committed straight away, under the preview's curtain, as one Undo
// step; then the runs and the copy slide the few points left to where the moved note draws them
// (a box or indent the block gained on arrival fades in) and the curtain comes down when the
// slides end, at most 0.4 s after the release, uncovering the same picture. The screen does not
// scroll. No block lifts until the curtain is down.

/// A drop whose preview is settling over the moved note: what comes down when it ends, and the
/// revision the move left the note at (any other change ends it at once).
@MainActor
final class TextFirstReflowLanding {
    let preview: TextFirstReflow
    let dimmedSource: UIView
    let revision: UInt64
    init(_ preview: TextFirstReflow, dimmedSource: UIView, revision: UInt64) {
        (self.preview, self.dimmedSource, self.revision) = (preview, dimmedSource, revision)
    }
}

extension TextFirstEditorController {
    /// The finger lifted (`dropping`) or iOS cancelled the touch during a previewed drag: move
    /// the block to the gap shown, or, with the gap at home or a move refused, let what slid
    /// go back and take the preview down.
    func landPreview(_ drag: TextFirstBlockDrag, _ preview: TextFirstReflow, dropping: Bool) {
        let released = CACurrentMediaTime()
        drag.handOffToLanding()
        drag.card.removeFromSuperview()
        drag.dropLine.removeFromSuperview()
        var moved = false
        if dropping, outsideChangesPending == 0, drag.lift.revision == rev, let slot = preview.slot
        {
            let interval = TextFirstReflowMotion.signposts.beginInterval("land")
            preview.solidify()
            moved = commitUnderPreview(drag, preview, to: slot)
            TextFirstReflowMotion.signposts.endInterval("land", interval)
            TextFirstReflowMotion.log.debug(
                "drop committed and settling in \((CACurrentMediaTime() - released) * 1000, format: .fixed(precision: 1), privacy: .public) ms"
            )
        }
        let landing = TextFirstReflowLanding(
            preview, dimmedSource: drag.dimmedSource, revision: rev)
        reflowLanding = landing
        if moved {
            dragHaptics.landed()
        } else {
            preview.retreat {}
        }
        let left = preview.isOpen ? max(0, preview.slidesEnd - CACurrentMediaTime()) : 0
        let wait = min(left, TextFirstReflowMotion.landingCap - (CACurrentMediaTime() - released))
        guard wait > 0 else { return finishLanding() }
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self, weak landing] in
            guard let self, let landing, self.reflowLanding === landing else { return }
            self.finishLanding()
        }
    }

    /// The curtain, the copy and the dim come down: the note under them is the moved note.
    func finishLanding() {
        guard let landing = reflowLanding else { return }
        reflowLanding = nil
        landing.preview.remove()
        landing.dimmedSource.removeFromSuperview()
    }

    /// Move the block to `slot` under the curtain, hold the screen still, and set the preview
    /// sliding to where the moved note is drawn. False when the engine refused the move.
    private func commitUnderPreview(
        _ drag: TextFirstBlockDrag, _ preview: TextFirstReflow, to slot: TextFirstBlockSlot
    ) -> Bool {
        let scrolled = textView.contentOffset
        let lines = landingLines(preview.plan, drag.book, to: slot)
        do {
            guard try moveBlock(at: drag.lift.offset, to: slot) else { return false }
        } catch {
            recover(error, context: "move block")
            return false
        }
        textView.layoutIfNeeded()
        if textView.contentOffset != scrolled {
            textView.contentOffset = scrolled
            textView.layoutIfNeeded()
        }
        let plan = preview.plan
        // Text above both the block's place and the gap did not move: if TextKit placed it
        // elsewhere (it settles estimates above the screen), the screen follows it.
        if min(plan.home, preview.gap) > 0, let first = plan.runs.first,
            let laidOut = laidOutRange(),
            let top = edgeY(first.anchor, laidOut).map({ $0 + first.inset }),
            abs(top - first.top) > 0.25
        {
            let dy = top - first.top
            textView.contentOffset.y += dy
            textView.layoutIfNeeded()
            preview.follow(boundsBy: dy)
        }
        let landed = landedFrames(plan, gap: preview.gap, lines)
        preview.settle(runs: landed.runs, block: landed.block, over: TextFirstReflowMotion.slide)
        return true
    }
}

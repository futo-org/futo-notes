import UIKit

// The block drag's live preview as a drag runs it (#448): started at the lift unless Reduce
// Motion is on (checked at the lift) or it cannot be built (logged, and the drag shows the drop
// line), and measured again with every layout change and every frame the note autoscrolls
// (#449).

extension TextFirstEditorController {
    /// With Reduce Motion on the drag shows the drop line and nothing slides.
    var reducesMotion: Bool { UIAccessibility.isReduceMotionEnabled || debugReducesMotion }

    var slicePainter: TextFirstSlicePainter { TextFirstSlicePainter(textView: textView) }

    /// The card for `lift` with the finger at `p`, the block drawn by the editor (a snapshot of
    /// the screen should that fail).
    func blockCard(_ lift: TextFirstLift, finger p: CGPoint) -> UIView {
        let painter = slicePainter
        let insets = textView.adjustedContentInset
        let shown = textView.bounds.inset(
            by: UIEdgeInsets(top: insets.top, left: 0, bottom: insets.bottom, right: 0))
        let screen = textView.window?.screen.bounds.height ?? textView.bounds.height
        let block = lift.frame
        let frame = TextFirstBlockCard.frame(for: block, finger: p, shown: shown, screen: screen)
        // Only what the card can show is drawn.
        var drawn = block
        drawn.size.height = min(block.height, frame.height)
        if let image = painter.paint(drawn, opaque: false) {
            return TextFirstBlockCard.make(
                image, of: block, at: frame, surface: painter.surface, scale: painter.scale)
        }
        TextFirstReflowMotion.log.notice("block drag card: drawing failed, using a snapshot")
        let card = TextFirstBlockCard.make(
            nil, of: block, at: frame, surface: painter.surface, scale: painter.scale)
        if let snapshot = textView.resizableSnapshotView(
            from: block, afterScreenUpdates: false, withCapInsets: .zero)
        {
            snapshot.frame.origin = CGPoint(
                x: block.minX - frame.minX, y: TextFirstBlockCard.pad)
            card.subviews.first?.addSubview(snapshot)
        }
        return card
    }

    /// Give `drag` its live preview, drawn in idle time from the next frame on.
    func startPreview(_ drag: TextFirstBlockDrag) {
        guard !reducesMotion else { return }
        do {
            let (plan, closedLine) = try reflowPlan(drag.book, drag.targets)
            let painter = slicePainter
            let preview = TextFirstReflow(
                plan, closedLine: closedLine, painter: painter, under: drag.card)
            let block = drag.book.block
            preview.drawBlock = { [weak self] rect, top in
                self?.blockLayout(block.range, toEnd: block.toEnd)?.paint(
                    rect, blockTop: top, with: painter)
            }
            drag.preview = preview
            preview.buildInIdleTime()
        } catch {
            previewUnavailable(error, drag)
        }
    }

    /// The layout changed under a previewed drag: read the plan again from it. A pass that
    /// cannot be read (TextKit still laying out, mid-rotation) is read again on the next turn
    /// of the run loop before the drag gives the preview up.
    func remeasurePreview(
        _ drag: TextFirstBlockDrag, _ preview: TextFirstReflow, retried: Bool = false
    ) {
        guard !preview.retreating else { return }
        do {
            let (plan, closedLine) = try reflowPlan(
                drag.book, drag.targets, reusing: preview.closedLine, known: preview.known,
                measured: preview.measured)
            preview.remeasure(plan, closedLine: closedLine, finger: drag.fingerY)
        } catch  where !retried {
            DispatchQueue.main.async { [weak self, weak drag] in
                guard let self, let drag, self.blockDrag === drag, drag.preview === preview
                else { return }
                drag.remeasured((try? self.dropTargets(&drag.book)) ?? drag.targets)
                self.remeasurePreview(drag, preview, retried: true)
            }
        } catch {
            previewUnavailable(error, drag)
            // The drop line takes over within the note's scroll (the preview may have taken
            // it past the end).
            withinScroll(preview)
            preview.remove()
            drag.preview = nil
        }
        drag.place()
    }

    private func previewUnavailable(_ error: Error, _ drag: TextFirstBlockDrag) {
        let reason = String(describing: error)
        drag.previewUnavailable = reason
        TextFirstReflowMotion.log.error(
            "block drag shows the drop line: no preview (\(reason, privacy: .public))")
        print("text-first: block drag preview unavailable: \(reason)")
    }
}

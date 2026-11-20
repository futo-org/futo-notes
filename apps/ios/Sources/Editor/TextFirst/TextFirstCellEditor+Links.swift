import UIKit
import UIKit.UIGestureRecognizerSubclass

// A tap on link text in the OPEN cell opens the link (the other half of
// `handleCellTap`'s rule). The recognizer fails at touch-down anywhere but on link text, so a
// tap elsewhere in the field is the text view's own, undelayed; on link text it takes the tap
// and the text view's gestures wait for it (no caret move, no selection change).

final class TextFirstCellLinkTap: UIGestureRecognizer, UIGestureRecognizerDelegate {
    weak var editor: TextFirstCellEditor?
    private var start = CGPoint.zero
    private var timeout: DispatchWorkItem?

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        delegate = self
    }

    private func cancelTimeout() {
        timeout?.cancel()
        timeout = nil
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard touches.count == 1, let touch = touches.first, let view,
            MainActor.assumeIsolated({ editor?.linkTarget(at: touch.location(in: view)) != nil })
        else {
            state = .failed
            return
        }
        start = touch.location(in: view)
        // A press that is not a tap (a long press moving the caret) is not ours.
        let work = DispatchWorkItem { [weak self] in
            if self?.state == .possible { self?.state = .failed }
        }
        timeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let touch = touches.first, let view, state == .possible else { return }
        let p = touch.location(in: view)
        if hypot(p.x - start.x, p.y - start.y) > 10 { state = .failed }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        cancelTimeout()
        if state == .possible { state = .recognized }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        cancelTimeout()
        state = .failed
    }

    override func reset() { cancelTimeout() }

    func gestureRecognizer(
        _ g: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer
    ) -> Bool { other.view === view }
}

extension TextFirstCellEditor {
    func installLinkTap() {
        let tap = TextFirstCellLinkTap(target: self, action: #selector(linkTapped(_:)))
        tap.editor = self
        field.addGestureRecognizer(tap)
    }

    @objc func linkTapped(_ g: UIGestureRecognizer) {
        guard g.state == .ended, let view = g.view, let target = linkTarget(at: g.location(in: view))
        else { return }
        controller.open(target)
    }

    /// The link under `p` (field coordinates), by laying the field's text out as the grid draws it.
    func linkTarget(at p: CGPoint) -> TextFirstLinkTarget? {
        guard !isFinished, !controller.engineBusy, field.markedTextRange == nil,
            linkRuns.contains(where: { $0.link != nil }),
            let (span, content) = controller.tableCell(at: cellStart)
        else { return nil }
        let pad = TextFirstTableMetrics.padding
        let text = field.text ?? ""
        let cell = TextFirstTableRowSpan.Cell(
            column: content.column, text: text, alignment: content.alignment,
            range: NSRange(location: cellStart, length: (text as NSString).length), rowOffset: 0,
            runs: linkRuns)
        return controller.linkTarget(
            inCell: cell, header: span.header, columns: span.columns,
            local: CGPoint(x: p.x - pad, y: p.y - pad))
    }
}

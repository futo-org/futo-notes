import UIKit

// A tap on a task's checkbox toggles it through the engine (`ToggleTask`) and leaves the caret
// and the keyboard where they were; the checkbox is drawn over the item's marker unit.

extension TextFirstEditorController: UIGestureRecognizerDelegate {
    /// Whether the selection covers all of `run`, a glyph run in `fragment`'s paragraph.
    func selectionCovers(
        _ run: NSRange, in fragment: NSTextLayoutFragment, _ manager: NSTextLayoutManager
    ) -> Bool {
        let selected = textView.selectedRange
        guard selected.length > 0 else { return false }
        let start = manager.offset(
            from: manager.documentRange.location, to: fragment.rangeInElement.location)
        return selected.location <= start + run.location
            && NSMaxRange(selected) >= start + NSMaxRange(run)
    }

    /// Repaint the rows whose image tint may change with the selection.
    func invalidateImageHighlights(old: NSRange, new: NSRange) {
        guard old.length > 0 || new.length > 0, let manager = textView.textLayoutManager,
            let content = manager.textContentManager
        else { return }
        let union = NSUnionRange(old, new)
        let from = content.location(
            manager.documentRange.location, offsetBy: min(union.location, storage.length))
        let to = content.location(
            manager.documentRange.location, offsetBy: min(NSMaxRange(union), storage.length))
        if let from, let to, let range = NSTextRange(location: from, end: to) {
            manager.invalidateLayout(for: range)
        }
    }

    func installTapRecognizer() {
        installMarkerHold()
        layoutDelegate.host = self
        textView.textLayoutManager?.delegate = layoutDelegate
        (textView.textLayoutManager?.textContentManager as? NSTextContentStorage)?.delegate =
            typesetDelegate
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        textView.addGestureRecognizer(tap)
        checkboxTap = tap
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handleTablePan(_:)))
        pan.delegate = self
        textView.addGestureRecognizer(pan)
        tablePan = pan
        let tracker = TextFirstTouchTracker(target: nil, action: nil)
        tracker.onChange = { [weak self] down in
            self?.textView.fingerIsDown = down
            if !down { self?.renderHoldChanged() }
        }
        textView.addGestureRecognizer(tracker)
        installBlockDrag()
    }

    /// Our recognizers share every touch, except the block lift: once it lifts, the touch is
    /// the drag's alone (the touch tracker aside, which never recognizes).
    func gestureRecognizer(
        _ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        guard g === liftRecognizer || other === liftRecognizer else { return true }
        return g is TextFirstTouchTracker || other is TextFirstTouchTracker
    }

    /// While a press may lift, UIKit's long-presses on the note (the loupe, long-press
    /// selection) wait for the lift to fail: they act only where a press lifts nothing.
    /// While a press may lift, or came down on a list marker while the note is edited, UIKit's
    /// long-presses on the note wait for ours to fail.
    func gestureRecognizer(
        _ g: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer
    ) -> Bool {
        let armed =
            (g === liftRecognizer && liftArmed) || (g === markerHoldRecognizer && markerHoldArmed)
        return armed && other !== g && other is UILongPressGestureRecognizer
            && other.view === textView
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        // A press that may not lift is never the lift's: the platform has it from touch-down.
        if g === liftRecognizer { return liftArmed }
        if g === markerHoldRecognizer {
            markerHoldArmed =
                textView.isFirstResponder
                && markerUnitFragment(at: touch.location(in: textView)) != nil
            return markerHoldArmed
        }
        selectionBeforeTouch = textView.selectedRange
        let p = touch.location(in: textView)
        touchOpensNoCaretMenu = markerUnitFragment(at: p) != nil || codeBlockEdge(at: p) != nil
        touchHitCheckbox = checkboxFragment(at: p) != nil
        // A touch on a checkbox or a link is that control's alone: the text view does not take
        // focus (no caret, no keyboard), as Android's touch handler consumes it.
        suppressFocus =
            touchHitCheckbox || linkTarget(at: p) != nil || tableRowHit(at: p) != nil
        if suppressFocus {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                MainActor.assumeIsolated { self?.suppressFocus = false }
            }
        }
        return true
    }

    var inset: UIEdgeInsets { textView.textContainerInset }

    private func fragment(at p: CGPoint) -> NSTextLayoutFragment? {
        textView.textLayoutManager?.textLayoutFragment(
            for: CGPoint(x: p.x - inset.left, y: p.y - inset.top))
    }

    /// The fragment whose list marker unit holds `p`: across the unit, from where the item's
    /// text starts to the far edge of its marker column, and the row's height with a margin.
    func markerUnitFragment(at p: CGPoint) -> TextFirstLayoutFragment? {
        guard let f = fragment(at: p) as? TextFirstLayoutFragment, let unit = f.markerUnit
        else { return nil }
        let rect = unit.rect.offsetBy(dx: inset.left, dy: f.layoutFragmentFrame.minY + inset.top)
            .insetBy(dx: 0, dy: -8)
        return rect.contains(p) ? f : nil
    }

    /// The fragment whose task checkbox (its marker unit) holds `p`.
    func checkboxFragment(at p: CGPoint) -> TextFirstLayoutFragment? {
        markerUnitFragment(at: p).flatMap { $0.block.list?.marker == .task ? $0 : nil }
    }

    /// The storage range of the image whose drawn rect holds `p`, if any.
    func imageHit(at p: CGPoint) -> NSRange? { imageAt(p)?.range }

    /// The image whose drawn rect holds `p`: its storage range and that rect in text view
    /// coordinates.
    func imageAt(_ p: CGPoint) -> (range: NSRange, frame: CGRect)? {
        guard let f = fragment(at: p) as? TextFirstLayoutFragment, !f.imageRuns.isEmpty,
            let manager = textView.textLayoutManager
        else { return nil }
        let origin = CGPoint(x: inset.left, y: inset.top + f.layoutFragmentFrame.minY)
        let local = CGPoint(x: p.x - origin.x, y: p.y - origin.y)
        let base = manager.offset(
            from: manager.documentRange.location, to: f.rangeInElement.location)
        for run in f.imageRuns {
            if let rect = f.imageRect(run), rect.contains(local) {
                return (
                    NSRange(location: base + run.range.location, length: run.range.length),
                    rect.offsetBy(dx: origin.x, dy: origin.y)
                )
            }
        }
        return nil
    }

    /// A plain tap on an image, anywhere on it, is a collapsed caret right after it (the
    /// caret is drawn at its trailing edge): typing goes after the image and Backspace removes
    /// it whole. A drag selection or select-all still selects it as one object (with the
    /// keyboard down a long-press lifts it, or its line, +BlockDrag).
    private func placeCaretAfterImage(_ range: NSRange) {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.closed, NSMaxRange(range) <= self.storage.length else {
                    return
                }
                self.textView.selectedRange = NSRange(location: NSMaxRange(range), length: 0)
            }
        }
    }

    /// A horizontal drag that starts on a table scrolls all its columns together; any other
    /// drag is the text view's own. The block lift begins only where it can lift (+BlockDrag).
    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        if g === liftRecognizer { return liftShouldBegin(at: g.location(in: textView)) }
        guard g === tablePan, let pan = g as? UIPanGestureRecognizer else { return true }
        let v = pan.velocity(in: textView)
        return abs(v.x) > abs(v.y) && tableRowHit(at: pan.location(in: textView)) != nil
    }

    @objc func handleTablePan(_ g: UIPanGestureRecognizer) {
        switch g.state {
        case .began:
            // The text view's own scrolling stands down for this drag.
            textView.panGestureRecognizer.isEnabled = false
            textView.panGestureRecognizer.isEnabled = true
            let start = g.location(in: textView)
                .applying(
                    CGAffineTransform(
                        translationX: -g.translation(in: textView).x,
                        y: -g.translation(in: textView).y))
            if let hit = tableRowHit(at: start) {
                tablePanRow = (hit.row, hit.span)
                tablePanOrigin = tableScroll[hit.span.tableStart] ?? 0
            }
        case .changed:
            guard let (row, span) = tablePanRow else { return }
            scrollTable(
                startingAt: span.tableStart, columns: span.columns,
                to: tablePanOrigin - g.translation(in: textView).x, around: row)
        default:
            tablePanRow = nil
        }
    }

    @objc func handleTap(_ g: UITapGestureRecognizer) {
        // A cell, an image or a checkbox is the engine's to change: nothing until it lands.
        if engineBusy, g.state == .ended, linkTarget(at: g.location(in: textView)) == nil {
            touchHitCheckbox = false
            suppressFocus = false
            return
        }
        if g.state == .ended, let edge = codeBlockEdge(at: g.location(in: textView)) {
            openLine(beside: edge)
            return
        }
        if g.state == .ended, let hit = tableCellHit(at: g.location(in: textView)) {
            suppressFocus = false
            openCellEditor(hit)
            return
        }
        if g.state == .ended, !touchHitCheckbox,
            let image = imageHit(at: g.location(in: textView))
        {
            placeCaretAfterImage(image)
            return
        }
        if g.state == .ended, !touchHitCheckbox,
            let target = linkTarget(at: g.location(in: textView))
        {
            suppressFocus = false
            applying += 1
            textView.selectedRange = selectionBeforeTouch
            applying -= 1
            open(target)
            return
        }
        guard g.state == .ended, touchHitCheckbox,
            let f = checkboxFragment(at: g.location(in: textView)),
            let manager = textView.textLayoutManager
        else { return }
        touchHitCheckbox = false
        suppressFocus = false
        let offset = manager.offset(
            from: manager.documentRange.location, to: f.rangeInElement.location)
        // The text view may have moved its caret to the tap (and told the engine): put it back.
        toggleTask(atLineOffset: offset, keeping: selectionBeforeTouch)
    }

    /// Toggle the task on the line at `offset`, leaving the selection at `kept` (what it was
    /// before the touch, or before puppet's `ToggleTask`). In a focused note UIKit has already
    /// moved the caret to the tap and reported it, so the engine is told the kept one too.
    func toggleTask(atLineOffset offset: Int, keeping kept: NSRange) {
        toggleTask(atLineOffset: offset)
        applying += 1
        textView.selectedRange = kept
        applying -= 1
        if !closed, !engineBusy, kept != engineSelection { reportSelection(kept) }
    }

    func toggleTask(atLineOffset offset: Int) {
        guard !closed, !engineBusy else { return }
        finishComposition()
        do {
            let at = EditorUtf16Range(start: UInt64(offset), end: UInt64(offset))
            if let change = try session.blockCommandUtf16(
                expected: rev, range: at, command: .toggleTask)
            {
                try accept(change)
            }
        } catch { recover(error, context: "toggle task") }
    }
}

#if FUTO_DEBUG_BUILD
    import UIKit

    // A tap on a task's checkbox toggles it through the engine (`ToggleTask`) and leaves the caret
    // and the keyboard where they were; the checkbox is drawn by a layout fragment, not a character.

    extension TextFirstEditorController: UIGestureRecognizerDelegate {
        func installTapRecognizer() {
            textView.textLayoutManager?.delegate = layoutDelegate
            let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
            tap.cancelsTouchesInView = false
            tap.delegate = self
            textView.addGestureRecognizer(tap)
        }

        func gestureRecognizer(
            _ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool { true }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            selectionBeforeTouch = textView.selectedRange
            touchHitCheckbox = checkboxFragment(at: touch.location(in: textView)) != nil
            return true
        }

        private var inset: UIEdgeInsets { textView.textContainerInset }

        private func fragment(at p: CGPoint) -> NSTextLayoutFragment? {
            textView.textLayoutManager?.textLayoutFragment(
                for: CGPoint(x: p.x - inset.left, y: p.y - inset.top))
        }

        /// The fragment whose checkbox (with a generous touch margin) holds `p`.
        func checkboxFragment(at p: CGPoint) -> TextFirstLayoutFragment? {
            guard let f = fragment(at: p) as? TextFirstLayoutFragment, let box = f.checkboxRect else {
                return nil
            }
            let frame = f.layoutFragmentFrame
            let rect = box.offsetBy(dx: inset.left, dy: frame.minY + inset.top).insetBy(dx: -12, dy: -12)
            return rect.contains(p) ? f : nil
        }

        @objc func handleTap(_ g: UITapGestureRecognizer) {
            guard g.state == .ended, touchHitCheckbox, let f = checkboxFragment(at: g.location(in: textView)),
                let manager = textView.textLayoutManager
            else { return }
            touchHitCheckbox = false
            let offset = manager.offset(
                from: manager.documentRange.location, to: f.rangeInElement.location)
            toggleTask(atLineOffset: offset)
            // The text view moved its caret to the tap; the engine never heard about it.
            applying += 1
            textView.selectedRange = selectionBeforeTouch
            applying -= 1
        }

        func toggleTask(atLineOffset offset: Int) {
            guard !closed else { return }
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
#endif

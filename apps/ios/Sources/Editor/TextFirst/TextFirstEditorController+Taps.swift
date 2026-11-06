#if FUTO_DEBUG_BUILD
    import UIKit

    // A tap on a task's checkbox toggles it through the engine (`ToggleTask`) and leaves the caret
    // and the keyboard where they were; the checkbox is drawn by a layout fragment, not a character.

    extension TextFirstEditorController: UIGestureRecognizerDelegate {
        /// The text of `fragment`'s row spans the selection: a non-empty selection that starts at or
        /// before the row's first character and ends at or after its last (its line break aside).
        func selectionRange(for fragment: NSTextLayoutFragment, in manager: NSTextLayoutManager)
            -> NSRange?
        {
            let selected = textView.selectedRange
            guard selected.length > 0 else { return nil }
            let start = manager.offset(
                from: manager.documentRange.location, to: fragment.rangeInElement.location)
            let end =
                start
                + manager.offset(
                    from: fragment.rangeInElement.location, to: fragment.rangeInElement.endLocation)
            let text = storage.string as NSString
            let rowEnd = (end > start && text.character(at: end - 1) == 0x0A) ? end - 1 : end
            return selected.location <= start && NSMaxRange(selected) >= rowEnd ? selected : nil
        }

        /// Repaint the rows whose marker highlight may change with the selection.
        func invalidateMarkerHighlights(old: NSRange, new: NSRange) {
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
            layoutDelegate.host = self
            textView.textLayoutManager?.delegate = layoutDelegate
            let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
            tap.cancelsTouchesInView = false
            tap.delegate = self
            textView.addGestureRecognizer(tap)
            checkboxTap = tap
        }

        func gestureRecognizer(
            _ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool { true }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            selectionBeforeTouch = textView.selectedRange
            let p = touch.location(in: textView)
            touchHitCheckbox = checkboxFragment(at: p) != nil
            // A touch on a checkbox or a link is that control's alone: the text view does not take
            // focus (no caret, no keyboard), as Android's touch handler consumes it.
            suppressFocus = touchHitCheckbox || linkTarget(at: p) != nil
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

        /// The fragment whose checkbox (with a generous touch margin) holds `p`.
        func checkboxFragment(at p: CGPoint) -> TextFirstLayoutFragment? {
            guard let f = fragment(at: p) as? TextFirstLayoutFragment, let box = f.checkboxRect
            else {
                return nil
            }
            let frame = f.layoutFragmentFrame
            let rect = box.offsetBy(dx: inset.left, dy: frame.minY + inset.top).insetBy(
                dx: -12, dy: -12)
            return rect.contains(p) ? f : nil
        }

        /// The storage range of the image whose drawn rect holds `p`, if any.
        func imageHit(at p: CGPoint) -> NSRange? {
            guard let f = fragment(at: p) as? TextFirstLayoutFragment, !f.imageRuns.isEmpty,
                let manager = textView.textLayoutManager
            else { return nil }
            let local = CGPoint(
                x: p.x - inset.left, y: p.y - inset.top - f.layoutFragmentFrame.minY)
            let base = manager.offset(
                from: manager.documentRange.location, to: f.rangeInElement.location)
            for run in f.imageRuns {
                if let rect = f.imageRect(run), rect.contains(local) {
                    return NSRange(location: base + run.range.location, length: run.range.length)
                }
            }
            return nil
        }

        /// A short tap on an image selects it as one object (its two caret stops, start to end);
        /// Enter then acts after it, which is how a caret gets past a last image.
        private func selectImage(_ range: NSRange) {
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, !self.closed, NSMaxRange(range) <= self.storage.length else {
                        return
                    }
                    self.textView.selectedRange = range
                }
            }
        }

        @objc func handleTap(_ g: UITapGestureRecognizer) {
            if g.state == .ended, !touchHitCheckbox,
                let image = imageHit(at: g.location(in: textView))
            {
                selectImage(image)
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

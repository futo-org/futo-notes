#if FUTO_DEBUG_BUILD
    import UIKit

    // Styling from the engine's projection: the first screen at once, the rest of a long note in
    // slices, and one window per accepted change (the change's own reparsed window).

    extension TextFirstEditorController {
        private static let firstSlice = 6_000
        private static let laterSlice = 12_000

        func styleFirstScreen() {
            styleSlice(units: Self.firstSlice)
            scheduleNextSlice()
        }

        /// Style the next `units` UTF-16 units from `styledThrough`.
        private func styleSlice(units: Int) {
            guard !closed, !engineBusy, styledThrough < mirrorLength else { return }
            let from = styledThrough
            do {
                // The engine's rule for a slice's end (a blank line, so no table is cut in two:
                // the engine reports a table only from the slice it starts in).
                let to = Int(try mirror.sliceEnd(from: UInt64(from), chars: UInt64(units)))
                let startByte = try mirror.utf16ToByte(unit: UInt64(from))
                let endByte = try mirror.utf16ToByte(unit: UInt64(to))
                let specs = try session.stylePlan(
                    expected: rev, range: EditorByteRange(start: startByte, end: endByte))
                TextFirstStyler.apply(
                    specs, to: storage, window: NSRange(location: from, length: to - from),
                    images: images)
                styledThrough = to
            } catch {
                print("text-first: style plan failed: \(error)")
                styledThrough = mirrorLength
            }
        }

        /// A slice waits while a finger is on the note or its edit menu shows (the platform hides
        /// the menu and handles on a text change), and never follows another without a gap, so
        /// touches, scrolling and drawing run between slices.
        var renderHeld: Bool { textView.fingerIsDown || menuVisible }
        private static let sliceGap = 0.008

        func renderHoldChanged() {
            if !renderHeld { scheduleNextSlice() }
        }

        func scheduleNextSlice(after gap: Double = 0) {
            guard !styleSlicePending, !engineBusy, !renderHeld, styledThrough < mirrorLength
            else { return }
            styleSlicePending = true
            let work = { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.styleSlicePending = false
                    guard !self.renderHeld else { return }  // renderHoldChanged() resumes
                    var took = 0.0
                    // Typing and composing come first; a slice waits for the next turn.
                    if !self.engineComposing, self.textView.markedTextRange == nil {
                        let began = CACurrentMediaTime()
                        self.styleSlice(units: Self.laterSlice)
                        took = CACurrentMediaTime() - began
                    }
                    self.scheduleNextSlice(after: max(Self.sliceGap, took))
                }
            }
            if gap > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + gap, execute: work)
            } else {
                DispatchQueue.main.async(execute: work)
            }
        }

        /// Keep the styled prefix in step with an edit inside it. An edit that starts exactly where
        /// the prefix ends (typing or inserting at the end of the note) is inside it too: `restyle`
        /// styles that window at once, and everything keyed to the prefix (an image's re-layout
        /// when its bitmap arrives, the table pass) has to reach it.
        func adjustStyled(for edit: EditorMirrorEdit) {
            guard Int(edit.start) <= styledThrough else { return }
            styledThrough = max(
                Int(edit.start),
                min(
                    mirrorLength,
                    styledThrough + Int(edit.insertedUtf16) - Int(edit.end - edit.start)))
        }

        /// The engine plans only the table rows an edit's window meets. A line just past the window
        /// that is a table row where the window's last line is not (or the reverse) was drawn
        /// under the old table shape: hand the rest of the text back to the slices, from there.
        /// A plain keystroke never changes the grid state at the window's end, so it stays
        /// window-sized. `specs` is the plan just applied: the engine plans a row that starts
        /// exactly at `to` (windows are closed intervals), so that line is the window's last.
        private func continueStylingIfTheGridChangesAt(_ to: Int, specs: [EditorStyleSpan]) {
            let text = storage.string as NSString
            guard to < text.length, to <= styledThrough else { return }
            // The window ends at a line start (the line at `to` was not restyled, unless the plan
            // holds a row that starts there) or mid-line (that line is the window's last).
            let atLineStart =
                text.paragraphRange(for: NSRange(location: to, length: 0)).location == to
            let planned = specs.contains {
                if case .tableRow(let start, _, _, _, _, _) = $0 { return Int(start) == to }
                return false
            }
            let last = text.paragraphRange(
                for: NSRange(
                    location: atLineStart && !planned ? max(0, to - 1) : to, length: 0))
            guard NSMaxRange(last) < text.length else { return }
            let next = text.paragraphRange(for: NSRange(location: NSMaxRange(last), length: 0))
            guard
                !text.substring(with: next).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return }
            func inGrid(_ line: NSRange) -> Bool {
                storage.attribute(.tfTable, at: line.location, effectiveRange: nil) != nil
                    || storage.attribute(.tfTableDelimiter, at: line.location, effectiveRange: nil)
                        != nil
            }
            guard inGrid(last) != inGrid(next) else { return }
            styledThrough = min(styledThrough, next.location)
            scheduleNextSlice()
        }

        /// Restyle the window the engine reparsed for `change`.
        func restyle(_ change: EditorViewChange) {
            guard !closed else { return }
            do {
                let range = change.projection.range
                let from = Int(try mirror.byteToUtf16(byte: range.start))
                let to = Int(try mirror.byteToUtf16(byte: range.end))
                // A window past the styled prefix is styled by the slices, from the current text.
                guard from <= styledThrough else { return }
                if to - from > Self.restyleAtOnce {
                    restyleProgressively(from: from, to: to)
                    return
                }
                let specs = try session.stylePlan(expected: rev, range: range)
                TextFirstStyler.apply(
                    specs, to: storage, window: NSRange(location: from, length: to - from),
                    images: images)
                continueStylingIfTheGridChangesAt(to, specs: specs)
            } catch {
                print("text-first: restyle failed: \(error)")
            }
        }
    }
#endif

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
            guard !closed, styledThrough < mirrorLength else { return }
            let from = styledThrough
            var to = min(mirrorLength, from + units)
            // End on a scalar boundary; a surrogate pair is never split.
            while to < mirrorLength, (try? mirror.utf16ToByte(unit: UInt64(to))) == nil { to += 1 }
            do {
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

        private func scheduleNextSlice() {
            guard !styleSlicePending, styledThrough < mirrorLength else { return }
            styleSlicePending = true
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.styleSlicePending = false
                    // Typing and composing come first; a slice waits for the next turn.
                    if !self.engineComposing, self.textView.markedTextRange == nil {
                        self.styleSlice(units: Self.laterSlice)
                    }
                    self.scheduleNextSlice()
                }
            }
        }

        /// Keep the styled prefix in step with an edit inside it.
        func adjustStyled(for edit: EditorMirrorEdit) {
            guard Int(edit.start) < styledThrough else { return }
            styledThrough = max(
                Int(edit.start),
                min(
                    mirrorLength,
                    styledThrough + Int(edit.insertedUtf16) - Int(edit.end - edit.start)))
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
                let specs = try session.stylePlan(expected: rev, range: range)
                TextFirstStyler.apply(
                    specs, to: storage, window: NSRange(location: from, length: to - from),
                    images: images)
            } catch {
                print("text-first: restyle failed: \(error)")
            }
        }
    }
#endif

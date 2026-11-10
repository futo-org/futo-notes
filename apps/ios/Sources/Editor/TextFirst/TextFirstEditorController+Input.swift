#if FUTO_DEBUG_BUILD
    import UIKit

    // The input layer. UIKit changes the text first and tells the delegate afterwards; this
    // reports each change to the engine through the call its shape needs and repaints the view
    // only where the engine's answer differs. The shapes were captured from real keyboards
    // (tests/fixtures/editor-native-input/README.md): typing is the typing seam, a text service's
    // replacement (autocorrect, a Korean syllable, whole-field paste) the OS-replacement seam,
    // marked text the composition seam, committed with the text the platform finally holds.

    extension TextFirstEditorController: UITextViewDelegate {
        func textView(
            _ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String
        ) -> Bool {
            guard applying == 0, !closed else { return true }
            // The engine has not landed: the view keeps its text, and the input waits its turn.
            if opening {
                queueWhileOpening(range, text)
                return false
            }
            // A large command is running on the engine; keys made meanwhile are not applied.
            if commandRunning { return false }
            // The view's selection stands for a larger one, the engine's: the key replaces that.
            if selectAllClipped, range == textView.selectedRange {
                if text == "\n" {
                    paragraphKey(.enter, range: engineSelection)
                } else {
                    report(engineSelection, text, applied: false)
                }
                return false
            }
            // Enter is the engine's: it decides the break's spelling and every list, quote and
            // heading rule. A newline typed into marked text stays UIKit's.
            if text == "\n", textView.markedTextRange == nil, !engineComposing,
                paragraphKey(.enter, range: range)
            {
                pendingEdit = nil
                return false
            }
            pendingEdit = (range, text)
            return true
        }

        func textView(
            _ textView: UITextView,
            willPresentEditMenuWith animator: any UIEditMenuInteractionAnimating
        ) {
            menuVisible = true
        }

        func textView(
            _ textView: UITextView,
            willDismissEditMenuWith animator: any UIEditMenuInteractionAnimating
        ) {
            menuVisible = false
            renderHoldChanged()
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) { viewportMoved() }

        func textViewDidChange(_ textView: UITextView) {
            // While opening, the view is never changed (its keys are queued); a change that got
            // here anyway cannot be reported to a session that does not exist.
            guard applying == 0, !closed, !opening else { return }
            platformChanged()
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            // The touch has placed its caret; what UIKit asks about from here on is on screen.
            self.textView.fingerIsDown = false
            invalidateMarkerHighlights(old: lastDrawnSelection, new: textView.selectedRange)
            lastDrawnSelection = textView.selectedRange
            if assertTrailingTypingAttributes() { invalidateLastParagraph() }
            syncEmptyLineTypingAttributes()
            syncImageTypingAttributes()
            if opening {
                // The keyboard reads the caret at once; the engine takes it when it lands.
                if applying == 0, !closed { queueSelectionWhileOpening(textView.selectedRange) }
                return
            }
            // The user chose a selection of their own.
            if applying == 0 { selectAllClipped = false }
            guard applying == 0, !closed, !commandRunning, !engineComposing,
                textView.markedTextRange == nil, pendingEdit == nil,
                // A text change not yet reported (no shouldChangeTextIn): its report must reach
                // the engine before any selection report.
                storage.length == mirrorLength
            else { return }
            var selected = textView.selectedRange
            // An image's glyphs have caret stops only at its two ends.
            let clamped = clampedOutOfImages(selected)
            if clamped != selected {
                selected = clamped
                applying += 1
                textView.selectedRange = clamped
                applying -= 1
            }
            guard selected != engineSelection else { return }
            reportSelection(selected)
        }

        /// Tell the engine where the view's selection now is, and take its answer.
        func reportSelection(_ selected: NSRange) {
            do {
                let change = try session.selectUtf16(
                    expected: rev, range: Self.range(selected))
                rev = change.revision
                let start = try mirror.byteToUtf16(byte: change.selection.start)
                let end = try mirror.byteToUtf16(byte: change.selection.end)
                setSelection(NSRange(location: Int(start), length: Int(end - start)))
                syncToolbar()
                refreshCompletion()
            } catch {
                recover(error, context: "selection")
            }
        }

        // MARK: platform edits

        func platformChanged() {
            let edit = pendingEdit
            pendingEdit = nil
            if textView.markedTextRange != nil {
                composing(edit)
            } else if engineComposing {
                commitComposition(edit)
            } else {
                reportPlatformChange(edit)
            }
        }

        private func reportPlatformChange(_ edit: (range: NSRange, text: String)?) {
            let length = storage.length
            if let edit, length == mirrorLength - edit.range.length + edit.text.utf16.count {
                report(edit.range, edit.text)
            } else {
                // UIKit's smart delete asks about the selection, then also removes a space beside
                // it in the same change; a text service may skip the delegate. Find the edit.
                resyncByDiff(hint: edit)
            }
        }

        /// `applied`: UIKit already made the edit (false when replaying input queued while the note opened).
        func report(_ range: NSRange, _ text: String, applied: Bool = true) {
            let units = Array(text.utf16)
            let placeholders = Self.dictationPlaceholders(in: units)
            do {
                let change: EditorViewChange?
                if !placeholders.isEmpty || (range.length > 0 && !units.isEmpty) {
                    change = try session.replaceOsUtf16(
                        expected: rev, range: Self.range(range), text: units,
                        placeholders: placeholders)
                } else {
                    change = try session.replaceUtf16Action(
                        expected: rev, range: Self.range(range), inserted: units,
                        action: units.count > 1 || range.length > 1 ? .isolated : .typing)
                }
                if let change {
                    try accept(change, platform: applied ? (range, text) : nil)
                } else if applied {
                    try rejectPlatformEdit((range, text))
                }
            } catch {
                recover(error, context: "input")
            }
        }

        /// A dictation placeholder is U+FFFC; the engine drops tagged ones before committing.
        private static func dictationPlaceholders(in units: [UInt16]) -> [EditorUtf16Range] {
            units.indices.filter { units[$0] == 0xFFFC }.map {
                EditorUtf16Range(start: UInt64($0), end: UInt64($0 + 1))
            }
        }

        /// The view changed text without a matching `shouldChangeTextIn`: diff it against the
        /// engine's display, bounded around the hint so a keystroke stays O(edit).
        private func resyncByDiff(hint: (range: NSRange, text: String)?) {
            let platform = storage.string as NSString
            let newLength = platform.length
            // No hint, no equal-length shortcut: a same-length replacement is only found by comparing.
            if hint == nil, newLength == mirrorLength, mirror.text() == (platform as String) {
                return
            }
            let radius = 32
            var from = 0
            var oldTo = mirrorLength
            if let hint {
                from = max(0, min(hint.range.location, newLength, mirrorLength) - radius)
                oldTo = min(mirrorLength, NSMaxRange(hint.range) + radius)
            }
            // The window's edges sit outside the edit, where the two texts agree: widen each to a
            // whole character (the engine refuses a range that splits a surrogate pair).
            if from > 0, from < newLength, UTF16.isTrailSurrogate(platform.character(at: from)) {
                from -= 1
            }
            let edge = oldTo + newLength - mirrorLength
            if oldTo < mirrorLength, edge >= from, edge < newLength,
                UTF16.isTrailSurrogate(platform.character(at: edge))
            {
                oldTo += 1
            }
            let newTo = oldTo + (newLength - mirrorLength)
            guard newTo >= from, newTo <= newLength,
                let oldSlice = try? mirror.sliceUtf16(start: UInt64(from), end: UInt64(oldTo))
            else {
                reloadFromEngine()
                return
            }
            let old = oldSlice as NSString
            let new =
                platform.substring(with: NSRange(location: from, length: newTo - from)) as NSString
            // A bare insertText at a caret inserted there; a minimal diff cannot tell which side
            // of a hidden run the text went.
            let caret = engineSelection.location - from
            let grown = new.length - old.length
            if engineSelection.length == 0, grown > 0, caret >= 0, caret <= old.length,
                old.substring(to: caret) == new.substring(to: caret),
                old.substring(from: caret) == new.substring(from: caret + grown)
            {
                report(
                    NSRange(location: engineSelection.location, length: 0),
                    new.substring(with: NSRange(location: caret, length: grown)))
                return
            }
            var prefix = 0
            let most = min(old.length, new.length)
            while prefix < most, old.character(at: prefix) == new.character(at: prefix) {
                prefix += 1
            }
            // 😀 → 😃 share their first UTF-16 unit; the change starts at the character's start.
            if prefix > 0, UTF16.isLeadSurrogate(old.character(at: prefix - 1)) { prefix -= 1 }
            var suffix = 0
            while suffix < most - prefix,
                old.character(at: old.length - 1 - suffix)
                    == new.character(at: new.length - 1 - suffix)
            { suffix += 1 }
            if suffix > 0, UTF16.isTrailSurrogate(old.character(at: old.length - suffix)) {
                suffix -= 1
            }
            let range = NSRange(location: from + prefix, length: old.length - prefix - suffix)
            let text = new.substring(
                with: NSRange(location: prefix, length: new.length - prefix - suffix))
            guard range.length > 0 || !text.isEmpty else { return }
            report(range, text)
        }

        // MARK: composition (marked text is the platform's until it commits)

        private func composing(_ edit: (range: NSRange, text: String)?) {
            guard let marked = textView.markedTextRange else { return }
            let text = textView.text(in: marked) ?? ""
            if !engineComposing {
                engineComposing = true
                // A keyboard that asked the delegate named the range the composition replaces; a
                // bare setMarkedText (reconversion over a selection) replaces the engine's selection.
                compositionRange = edit?.range ?? engineSelection
            }
            do {
                _ = try session.composeUtf16(
                    expected: rev, range: Self.range(compositionRange), text: Array(text.utf16))
            } catch {
                engineComposing = false
                recover(error, context: "compose")
            }
            lastMarked = text
        }

        /// `insertText` or a candidate committed the composition: with `edit.text` when the
        /// keyboard asked the delegate, else with whatever the platform now holds where it was
        /// (Korean commits a different syllable than the marked one).
        private func commitComposition(_ edit: (range: NSRange, text: String)?) {
            engineComposing = false
            let committed = edit?.text ?? committedText()
            let range = compositionRange
            do {
                let change = try session.commitCompositionUtf16(
                    expected: rev, text: committed == lastMarked ? nil : Array(committed.utf16))
                if let change {
                    try accept(change, platform: (range, committed))
                } else {
                    try rejectPlatformEdit((range, committed))
                }
            } catch {
                recover(error, context: "commit")
            }
        }

        /// The platform's text over the composition's range, grown or shrunk by the commit (the
        /// engine's display is still the pre-composition text).
        private func committedText() -> String {
            let platform = storage.string as NSString
            let length = compositionRange.length + platform.length - mirrorLength
            guard length >= 0, compositionRange.location + length <= platform.length else {
                return lastMarked
            }
            return platform.substring(
                with: NSRange(location: compositionRange.location, length: length))
        }

        /// `unmarkText()` with no text change: the marked text simply became real.
        func platformUnmarked() {
            guard engineComposing, applying == 0, !closed else { return }
            commitComposition(nil)
        }

        /// Make any marked text real before a command, a save or a leave.
        func finishComposition() {
            guard engineComposing || textView.markedTextRange != nil else { return }
            textView.unmarkText()
            if engineComposing { commitComposition(nil) }
        }
    }
#endif

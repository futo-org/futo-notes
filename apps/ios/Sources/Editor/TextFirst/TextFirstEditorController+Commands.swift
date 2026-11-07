#if FUTO_DEBUG_BUILD
    import UIKit

    // A toolbar command over a very large selection (Select All, then Bold) takes the engine
    // seconds in a long note: 3.9 s on the simulator host for a 2.3 MB note (2026-11-06). It runs
    // on the engine's queue, not the main thread, so the note stays scrollable; toolbar taps and
    // keys made meanwhile are not applied (Android: "toolbar taps made while an earlier action is
    // waiting or running are dropped"), and the result is applied in bounded pieces: the visible
    // text is styled at once and the rest in slices.

    extension TextFirstEditorController {
        /// A selection at least this long (UTF-16 units) takes the command off the main thread.
        static let heavySelection = 50_000
        /// A restyle window longer than this is styled around the viewport first, the rest in slices.
        static let restyleAtOnce = 40_000

        /// The engine cannot be called from the main thread now.
        var engineBusy: Bool { opening || engineJobs > 0 }
        var commandRunning: Bool { engineJobs > 0 }

        /// Run `work` on the engine's queue when the selection is large, else right here; then
        /// apply its change.
        func runCommand(
            _ context: String,
            _ work: @escaping @Sendable (NativeEditorSession, UInt64) throws -> EditorViewChange?
        ) {
            guard !closed, !engineBusy else { return }
            let expected = rev
            guard effectiveSelection.length >= Self.heavySelection else {
                finishCommand(context, Result { try work(session, expected) })
                return
            }
            engineJobs += 1
            let session = session
            io.async { [weak self] in
                let result = Result { try work(session, expected) }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        guard let self else { return }
                        self.engineJobs -= 1
                        self.finishCommand(context, result)
                        self.settleJobs()
                    }
                }
            }
        }

        private func finishCommand(_ context: String, _ result: Result<EditorViewChange?, Error>) {
            guard !closed else { return }
            do {
                if let change = try result.get() {
                    try accept(change)
                } else {
                    syncToolbar()
                }
            } catch EditorSessionError.UnrepresentableFormat {
                syncToolbar()
            } catch {
                recover(error, context: context)
            }
        }

        /// The toolbar's lit and dimmed ids for a selection too large to ask about on the main
        /// thread (the engine scans the selection: 2.2 s for all of a 2.3 MB note).
        func syncToolbarInBackground() {
            let session = session
            engineJobs += 1
            io.async { [weak self] in
                let highlights = try? session.toolbarHighlights()
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        guard let self else { return }
                        self.engineJobs -= 1
                        if let highlights, !self.closed { self.applyToolbar(highlights) }
                        self.settleJobs()
                    }
                }
            }
        }

        /// A job ended. With none left, the engine hears about a selection the view moved to
        /// meanwhile, saves are armed again and styling goes on.
        func settleJobs() {
            guard engineJobs == 0, !closed else { return }
            if !engineComposing, textView.markedTextRange == nil, pendingEdit == nil,
                storage.length == mirrorLength, textView.selectedRange != engineSelection
            {
                reportSelection(textView.selectedRange)
            }
            if drainDeferred { drainCoordinatedChanges() }
            startPendingFind()
            armSave()
            scheduleNextSlice()
        }

        // MARK: restyling a large window

        /// Style the text around the viewport at once, and put the rest of the window back in the
        /// slices' hands: they restyle from its start (restyling is idempotent), a screen's worth
        /// per main-queue turn.
        func restyleProgressively(from: Int, to: Int) {
            do {
                let visible = visibleUnits()
                let start = max(from, visible.lowerBound - 2_000)
                let end = min(
                    to,
                    Int(
                        try mirror.sliceEnd(
                            from: UInt64(start), chars: UInt64(visible.count + 4_000))))
                if end > start, let range = scalarRange(start, end) {
                    let specs = try session.stylePlan(expected: rev, range: range)
                    TextFirstStyler.apply(
                        specs, to: storage, window: NSRange(location: start, length: end - start),
                        images: images)
                }
            } catch {
                print("text-first: viewport restyle failed: \(error)")
            }
            styledThrough = min(styledThrough, from)
            scheduleNextSlice()
        }

        /// The UTF-16 units the viewport lays out.
        func visibleUnits() -> Range<Int> {
            guard let manager = textView.textLayoutManager,
                let shown = manager.textViewportLayoutController.viewportRange
            else { return 0..<min(mirrorLength, 6_000) }
            let origin = manager.documentRange.location
            return manager.offset(
                from: origin, to: shown.location)..<manager.offset(
                    from: origin, to: shown.endLocation)
        }

        /// The engine's byte range for a UTF-16 range, moved off any split character.
        private func scalarRange(_ start: Int, _ end: Int) -> EditorByteRange? {
            var s = start
            var e = end
            while s > 0, (try? mirror.utf16ToByte(unit: UInt64(s))) == nil { s -= 1 }
            while e < mirrorLength, (try? mirror.utf16ToByte(unit: UInt64(e))) == nil { e += 1 }
            guard let a = try? mirror.utf16ToByte(unit: UInt64(s)),
                let b = try? mirror.utf16ToByte(unit: UInt64(e))
            else { return nil }
            return EditorByteRange(start: a, end: b)
        }
    }
#endif

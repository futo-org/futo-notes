#if FUTO_DEBUG_BUILD
    import SwiftUI
    import UIKit

    // Find in note. Matching, stepping, wrap, table barriers, the count and rebasing through edits
    // are the engine's; this file converts what it reports to the view (host::plan_find through
    // `find_snapshot`, host::FindLanding through `find_step_landing`), paints the marks behind the
    // text, inside table cells and over images, and scrolls to a match. Find never edits the note,
    // so it adds no Undo step and no save.

    /// What the SwiftUI find bar shows. The bar only forwards the typed query and presses.
    @MainActor
    final class TextFirstFindModel: ObservableObject {
        @Published var visible = false
        @Published var query = ""
        @Published var total = 0
        @Published var current = 0
    }

    /// Per-note find bookkeeping (the matches themselves live in the engine session).
    struct TextFirstFindState {
        var open = false
        let landing = EditorFindLanding()
        /// The engine's matches as view ranges, ascending and non-overlapping.
        var marks: [NSRange] = []
        /// The current match's index in `marks`, or -1.
        var current = -1
        var scanning = false
        /// The query to scan for once the engine's current job ends (a long note's scan runs on the
        /// engine's queue; the latest query wins).
        var pendingQuery: String?
        var refresh: DispatchWorkItem?
        /// Where the note was when the bar opened; closing puts it back if nothing was edited.
        var restore: (rev: UInt64, selection: NSRange, offset: CGPoint)?

        /// Marks overlapping `[from, to)`, with whether each is the current one.
        func marks(from: Int, to: Int) -> [(range: NSRange, current: Bool)] {
            var lo = 0
            var hi = marks.count
            while lo < hi {
                let mid = (lo + hi) / 2
                if NSMaxRange(marks[mid]) <= from { lo = mid + 1 } else { hi = mid }
            }
            var out: [(NSRange, Bool)] = []
            var i = lo
            while i < marks.count, marks[i].location < to {
                out.append((marks[i], i == current))
                i += 1
            }
            return out
        }
    }

    enum TextFirstFindColors {
        static func fill(current: Bool) -> UIColor {
            current
                ? UIColor.systemOrange.withAlphaComponent(0.7)
                : UIColor.systemYellow.withAlphaComponent(0.5)
        }
    }

    extension TextFirstEditorController {
        private static let findRefreshDelay = 0.15

        func openFind() {
            guard !closed, !engineBusy else { return }
            if !findModel.visible {
                find.restore = (rev, engineSelection, textView.contentOffset)
                findModel.visible = true
            }
            setFindQuery(findModel.query)
        }

        /// A display this long is scanned off the main thread (about 10 ms per 100,000 units; a
        /// 2.3 MB note holds the main thread for 100 ms to seconds).
        static let findInBackgroundAbove = 200_000

        func setFindQuery(_ query: String) {
            guard !closed, !opening else { return }
            find.landing.reset()
            if mirrorLength >= Self.findInBackgroundAbove {
                find.pendingQuery = query
                startPendingFind()
                return
            }
            do {
                let report = try session.findSetQuery(expected: rev, query: query)
                find.open = report.open
                publishFind(reveal: report.reveal != nil)
            } catch { recover(error, context: "find query") }
        }

        /// Scan for the latest query on the engine's queue, then draw its marks.
        func startPendingFind() {
            guard let query = find.pendingQuery, engineJobs == 0, !closed else { return }
            find.pendingQuery = nil
            let expected = rev
            let session = session
            engineJobs += 1
            io.async { [weak self] in
                let report = Result { try session.findSetQuery(expected: expected, query: query) }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        guard let self else { return }
                        self.engineJobs -= 1
                        if !self.closed {
                            switch report {
                            case .success(let report):
                                self.find.open = report.open
                                self.publishFindIfCurrent(reveal: report.reveal != nil)
                            case .failure(let error): self.recover(error, context: "find query")
                            }
                        }
                        self.settleJobs()
                    }
                }
            }
        }

        /// The marks of a scan that ended, unless the bar closed or another query is waiting.
        private func publishFindIfCurrent(reveal: Bool) {
            guard find.open, find.pendingQuery == nil else { return }
            publishFind(reveal: reveal)
        }

        /// Next (`forward`) or previous match. The first press after the query changed lands on the
        /// current match; later ones move from it; during composition it does nothing.
        func stepFind(forward: Bool) {
            guard !closed, !engineBusy, find.open else { return }
            do {
                let step = try session.findStepLanding(
                    expected: rev, landing: find.landing, forward: forward,
                    composing: engineComposing)
                var landed = false
                if let range = step.landing {
                    let start = try mirror.byteToUtf16(byte: range.start)
                    let end = try mirror.byteToUtf16(byte: range.end)
                    selectInCell(NSRange(location: Int(start), length: Int(end - start)))
                    landed = true
                }
                publishFind(reveal: landed)
            } catch { recover(error, context: "find step") }
        }

        func closeFind() {
            guard !closed else { return }
            find.pendingQuery = nil
            // A scan is still running on the engine's queue: close when it ends.
            if engineJobs > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                    MainActor.assumeIsolated { self?.closeFind() }
                }
                return
            }
            find.refresh?.cancel()
            find.landing.reset()
            _ = try? session.findClose()
            find.open = false
            let restore = find.restore
            find.restore = nil
            setFindMarks([], current: -1)
            findModel.total = 0
            findModel.current = 0
            findModel.visible = false
            // Put back the selection and viewport from before find opened (spec: find-in-note.md).
            if let restore, restore.rev == rev {
                selectInCell(restore.selection)
                textView.setContentOffset(restore.offset, animated: false)
            }
        }

        /// The engine's view of find, drawn: marks, count, and (when asked) the current match
        /// brought on screen.
        func publishFind(reveal: Bool) {
            do {
                let snapshot = try session.findSnapshot(
                    expected: rev, mirror: mirror, composing: engineComposing, reveal: reveal)
                let marks = snapshot.matches.map {
                    NSRange(location: Int($0.start), length: Int($0.end - $0.start))
                }
                let index = Int(snapshot.current) - 1
                setFindMarks(marks, current: snapshot.open && index < marks.count ? index : -1)
                findModel.total = Int(snapshot.total)
                findModel.current = Int(snapshot.current)
                if reveal, let target = snapshot.reveal {
                    revealMatch(
                        NSRange(
                            location: Int(target.start), length: Int(target.end - target.start)))
                }
            } catch { recover(error, context: "find snapshot") }
        }

        private func setFindMarks(_ marks: [NSRange], current: Int) {
            guard marks != find.marks || current != find.current else { return }
            let wasEmpty = find.marks.isEmpty
            find.marks = marks
            find.current = current
            if !(wasEmpty && marks.isEmpty) { repaintViewport() }
        }

        /// Fragments are redrawn from the marks; only the screen's worth needs it now.
        private func repaintViewport() {
            guard let manager = textView.textLayoutManager else { return }
            // Before the first layout pass there is no viewport: take the whole note.
            var range = manager.textViewportLayoutController.viewportRange
            if range?.isEmpty != false { range = manager.documentRange }
            if let range { manager.invalidateLayout(for: range) }
            textView.setNeedsDisplay()
        }

        // MARK: after edits

        /// Input only logs its window in the engine; matches are rebased on read and a rescan of a
        /// snapshot replaces stale ones once typing settles.
        func scheduleFindRefresh() {
            guard !opening else { return }
            guard find.open, !closed else { return }
            find.refresh?.cancel()
            let work = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated { self?.refreshFind() }
            }
            find.refresh = work
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.findRefreshDelay, execute: work)
        }

        private func refreshFind() {
            guard find.open, !closed else { return }
            // A rescan due during a composition or an engine job waits for it to end.
            guard !engineBusy, !engineComposing else {
                scheduleFindRefresh()
                return
            }
            do {
                let report = try session.findReport()
                if report.stale, !find.scanning, let request = try session.findScanRequest() {
                    find.scanning = true
                    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                        let result = try? editorFindScan(request: request)
                        DispatchQueue.main.async {
                            MainActor.assumeIsolated { self?.finishFindScan(result) }
                        }
                    }
                }
                publishFind(reveal: false)
            } catch { recover(error, context: "find refresh") }
        }

        private func finishFindScan(_ result: EditorFindScanResult?) {
            find.scanning = false
            guard !closed, find.open, let result, !engineComposing else { return }
            do {
                if try session.findApplyScan(result: result) != nil { publishFind(reveal: false) }
            } catch { recover(error, context: "find scan") }
        }

        // MARK: scrolling

        /// Bring a match on screen: its line vertically (a third of the way down, as Android's
        /// `revealRange`), its column inside a wide table.
        func revealMatch(_ match: NSRange) {
            guard match.location <= storage.length else { return }
            if match.location < storage.length {
                var run = NSRange()
                if let span = storage.attribute(
                    .tfTable, at: match.location, effectiveRange: &run) as? TextFirstTableRowSpan,
                    let cell = span.cells.first(where: {
                        $0.range.location <= match.location
                            && match.location <= NSMaxRange($0.range)
                    })
                {
                    revealCell(cell, in: span, row: run)
                }
            }
            guard let manager = textView.textLayoutManager,
                let content = manager.textContentManager,
                let at = content.location(manager.documentRange.location, offsetBy: match.location)
            else { return }
            manager.ensureLayout(for: NSTextRange(location: at))
            guard let fragment = manager.textLayoutFragment(for: at) else { return }
            let base = manager.offset(
                from: manager.documentRange.location, to: fragment.rangeInElement.location)
            let line =
                fragment.textLineFragments.first {
                    NSLocationInRange(match.location - base, $0.characterRange)
                }?.typographicBounds ?? fragment.textLineFragments.first?.typographicBounds
                ?? .zero
            let top = inset.top + fragment.layoutFragmentFrame.minY + line.minY
            let bottom = top + line.height
            let adjusted = textView.adjustedContentInset
            let viewport = textView.bounds.height - adjusted.top - adjusted.bottom
            let offset = textView.contentOffset.y
            guard viewport > 0,
                top < offset + adjusted.top || bottom > offset + adjusted.top + viewport
            else { return }
            let maxOffset = max(
                -adjusted.top,
                textView.contentSize.height - textView.bounds.height + adjusted.bottom)
            let target = min(max(-adjusted.top, top - adjusted.top - viewport / 3), maxOffset)
            textView.setContentOffset(
                CGPoint(x: textView.contentOffset.x, y: target), animated: false)
        }
    }

    // MARK: the bar

    struct TextFirstFindBar: View {
        @ObservedObject var model: TextFirstFindModel
        @Environment(\.localization) private var localization
        let controller: TextFirstEditorController

        var body: some View {
            if model.visible { bar }
        }

        private var bar: some View {
            FindInNoteBar(
                query: $model.query,
                label: localization.localizedText(
                    "editor.find.matchCount",
                    arguments: ["current": model.current, "total": model.total]),
                onQueryChange: { controller.setFindQuery($0) },
                onStep: { controller.stepFind(forward: $0 > 0) },
                onClose: { controller.closeFind() }
            )
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Theme.background)
        }
    }
#endif

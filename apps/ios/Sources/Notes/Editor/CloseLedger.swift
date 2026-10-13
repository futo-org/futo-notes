import Foundation

#if DEBUG
    import QuartzCore
    import UIKit
    import UIKit.UIGestureRecognizerSubclass
    import os

    /// Debug-only phase ledger for LEAVING a note — the half of the editor's
    /// life no other probe sees (`docs/perf/mobile-close-ios.md`).
    ///
    /// Every phase is one `os_log` line in the `close-ledger` category, carrying
    /// both the wall clock (so an XCUITest on the same machine can relate it to
    /// its own Back tap) and the process uptime. Read it back with
    /// `xcrun simctl spawn <sim> log show --predicate 'category == "close-ledger"'`;
    /// `scripts/perf/ios-close-bench.mjs` does, per sample.
    ///
    /// Phases, in the order a system pop produces them (the bench adds
    /// `touchDown` / `touchUp` before them; see `installBenchTouchMarks`):
    ///   popObserved        the NavigationStack path shrank (NoteListView)
    ///   listFrame          the first screen refresh after that
    ///   editorDisappeared  the popped editor's onDisappear
    ///   bodyCurrent        its mailbox answered (`EditorHost.awaitCurrent`)
    ///   bodyClean | bodyCommitted   nothing to write | the Rust flush returned
    ///   titleCommitted     the title commit returned
    ///   exitSettled        finishLeave's chain is done
    ///
    /// Release builds compile every call to nothing (the `#else` below), so the
    /// marks cost the shipped app no work at all.
    enum CloseLedger {
        private static let log = Logger(subsystem: "com.futo.notes", category: "close-ledger")

        static func mark(_ phase: String, note: String = "") {
            let epochMs = Int64((Date().timeIntervalSince1970 * 1000).rounded())
            let uptimeMs = Int64((ProcessInfo.processInfo.systemUptime * 1000).rounded())
            log.notice(
                "close \(phase, privacy: .public) epochMs=\(epochMs, privacy: .public) uptimeMs=\(uptimeMs, privacy: .public) note=\(note, privacy: .public)"
            )
        }

        /// Marks `phase` on the next screen refresh: a real vsync, not a run-loop
        /// turn, so "the list is on screen" means a frame was drawn.
        @MainActor
        static func markOnNextFrame(_ phase: String, note: String = "") {
            NextFrame.schedule { mark(phase, note: note) }
        }

        /// Set only by `scripts/perf/ios-close-bench.mjs` (through its UI test).
        /// Nothing below runs without it, in any build.
        private static let benchRequested =
            ProcessInfo.processInfo.environment["FUTO_CLOSE_PERF"] == "1"

        /// The editor's debounced body save, held for the bench. An XCUITest
        /// cannot tap Back within the 400 ms debounce of a keystroke (its own
        /// idle wait after typing is ~1.7 s), so without this every "dirty"
        /// sample has already saved and measures a clean close.
        static func saveDebounceNanoseconds(_ shipped: UInt64) -> UInt64 {
            benchRequested ? 3_600_000_000_000 : shipped
        }

        /// Logs `touchDown` / `touchUp` for every touch in the app's windows,
        /// so the bench can anchor on the finger lifting off Back: XCUITest
        /// spends 1–3 s inside a tap call before it synthesizes the event, so
        /// no clock read in the test marks the tap. Installed only for the
        /// bench — a custom recognizer once broke the edge swipe
        /// (docs/learnings/ios-swipe-back-over-webview.md), and this one must
        /// never ride along in an ordinary debug run.
        @MainActor
        static func installBenchTouchMarks() {
            guard benchRequested else { return }
            for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
                for window in scene.windows
                where !(window.gestureRecognizers ?? []).contains(where: { $0 is TouchMarker }) {
                    window.addGestureRecognizer(TouchMarker())
                }
            }
        }
    }

    /// Watches touches without ever recognizing: it stays `.possible` until the
    /// touch ends, then fails, never cancels or delays a touch, and recognizes
    /// alongside every other recognizer.
    private final class TouchMarker: UIGestureRecognizer, UIGestureRecognizerDelegate {
        init() {
            super.init(target: nil, action: nil)
            cancelsTouchesInView = false
            delaysTouchesBegan = false
            delaysTouchesEnded = false
            delegate = self
        }

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            CloseLedger.mark("touchDown", note: describe(touches))
        }

        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
            CloseLedger.mark("touchUp", note: describe(touches))
            state = .failed
        }

        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
            state = .failed
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool { true }

        private func describe(_ touches: Set<UITouch>) -> String {
            guard let point = touches.first?.location(in: view) else { return "" }
            return "x=\(Int(point.x)),y=\(Int(point.y))"
        }
    }

    @MainActor
    private final class NextFrame: NSObject {
        private static var pending: [NextFrame] = []
        private var link: CADisplayLink?
        private let fire: () -> Void

        private init(fire: @escaping () -> Void) {
            self.fire = fire
            super.init()
            let link = CADisplayLink(target: self, selector: #selector(tick))
            link.add(to: .main, forMode: .common)
            self.link = link
        }

        static func schedule(_ fire: @escaping () -> Void) {
            pending.append(NextFrame(fire: fire))
        }

        @objc private func tick() {
            link?.invalidate()
            link = nil
            fire()
            Self.pending.removeAll { $0 === self }
        }
    }
#else
    enum CloseLedger {
        @inline(__always) static func mark(_ phase: String, note: String = "") {}
        @inline(__always) @MainActor static func markOnNextFrame(_ phase: String, note: String = "")
        {}
        @inline(__always) static func saveDebounceNanoseconds(_ shipped: UInt64) -> UInt64 {
            shipped
        }
        @inline(__always) @MainActor static func installBenchTouchMarks() {}
    }
#endif

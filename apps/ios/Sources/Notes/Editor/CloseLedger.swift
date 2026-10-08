import Foundation

#if DEBUG
    import QuartzCore
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
    /// Phases, in the order a system pop produces them:
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
        @inline(__always) @MainActor static func markOnNextFrame(_ phase: String, note: String = "") {}
    }
#endif

import Foundation

/// Receives live-sync events from Rust. NOT `@MainActor`: UniFFI invokes these on
/// a tokio worker thread, so each callback hops to the main actor before touching
/// `SyncManager`'s `@Published` state. `weak manager` breaks the retain cycle
/// (SyncManager → client → (Rust) listener → SyncManager). Never call back into
/// `SyncClient` here (e.g. `status()`) — that would deadlock a runtime worker.
final class LiveListener: SyncEventListener {
    weak var manager: SyncManager?
    init(manager: SyncManager) { self.manager = manager }

    func onSynced(summary: SyncSummary) {
        Task { @MainActor in
            guard let manager, manager.accepts(self) else { return }
            manager.applyLiveSummary(summary)
        }
    }
    func onConnected() {
        Task { @MainActor in
            guard let manager, manager.accepts(self) else { return }
            manager.setLive(true)
        }
    }
    func onError(message: String) {
        Task { @MainActor in
            guard let manager, manager.accepts(self) else { return }
            manager.setLastError(message)
        }
    }
    func onStopped() {
        Task { @MainActor in
            guard let manager, manager.accepts(self) else { return }
            manager.setLive(false)
        }
    }
}

extension SyncManager {
    // ── Live-listener callbacks (invoked on the main actor by LiveListener) ──

    fileprivate func accepts(_ listener: LiveListener) -> Bool {
        !resetting && liveListener === listener
    }

    func applyLiveSummary(_ s: SyncSummary) {
        applyOutcome(s)
        liveErrorMessage = nil
        // A live cycle wrote to disk — refresh the note list + open editor
        // (only on an actual change, incl. push-side merges; F2).
        if Self.wroteLocalChanges(s) { onLocalTreeChanged?(s) }
    }

    fileprivate func setLive(_ v: Bool) {
        live = v
        if v {
            liveErrorMessage = nil
        }
    }

    /// Sink for the Rust live loop's per-reconnect errors. A certificate
    /// rejection is reported as such whichever kind it arrives as (sync.md).
    /// Other connect/stream failures (`connect:` / `stream:` — the loop is
    /// retrying, the safety poll still runs) are live-stream health and go to
    /// the muted live error line. Anything else is a genuine failure and gets
    /// the red sync error line. `internal` so the unit tests can pin it.
    func setLastError(_ m: String) {
        // Auth expiry and collection-gone are terminal for the old live loop,
        // but recoverable from the securely stored password.
        if m.contains("collection-gone") || m.hasPrefix("auth:") {
            healSession()
            return
        }
        if Self.isCertificateRejection(m) {
            lastErrorMessage = LocalizedMessage("sync.errors.certificateNotTrusted")
        } else if m.hasPrefix("connect:") || m.hasPrefix("stream:") {
            liveErrorMessage = LocalizedMessage("sync.errors.liveUnavailable")
        } else {
            lastErrorMessage = LocalizedMessage("sync.errors.syncFailed")
        }
    }
}

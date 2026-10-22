import Foundation
import SwiftUI

/// Thin Swift wrapper over the Rust `SyncClient` (UniFFI). All sync/auth/E2EE
/// logic lives in Rust (crates/futo-notes-sync); this just drives it and
/// surfaces status to the UI.
@MainActor
final class SyncManager: ObservableObject {
    @Published var serverURL: String =
        UserDefaults.standard.string(forKey: "futo.serverURL") ?? SyncManager.defaultServerURL()

    /// The server URL fallback used only when the user hasn't persisted one.
    /// Debug builds default to the local dev server; release builds start
    /// empty so a shipped app never points at localhost.
    private static func defaultServerURL() -> String {
        #if DEBUG
            return "http://localhost:3005"
        #else
            return ""
        #endif
    }
    @Published var connected = false
    @Published var statusMessage = LocalizedMessage("sync.status.notConnected")
    @Published var busy = false
    /// A real pull/push/connect failure — shown in alarming red.
    @Published var lastErrorMessage: LocalizedMessage?

    /// Live-stream (SSE) health, separate from the sync error. A live-connect/stream
    /// error is NOT a sync failure: the loop reconnects with backoff and the
    /// periodic safety poll keeps reconciling. Kept distinct so a server without
    /// SSE (HTTP 404 on /api/sync/events) or a transient stream drop surfaces as
    /// a muted "live sync unavailable" hint, not a red "your sync broke" alarm.
    @Published var liveErrorMessage: LocalizedMessage?

    /// Whether the SSE live stream is currently connected.
    @Published var live = false

    /// Whether the LAST completed cycle's writes were refused, and which way
    /// (`futo_notes_sync::WriteRefusal`). Held here because this object
    /// outlives the sync sheet, and the whole point is that a refusal arrives
    /// while the person is somewhere else; `HostedSyncSections` hands it to the
    /// hosted model, which turns it into a banner with an action. Never a
    /// latch — every completed cycle writes its own answer, `nil` included.
    @Published private(set) var lastWriteRefusal: WriteRefusal?

    var resetting = false
    var liveStartsInFlight = 0

    /// False from `pauseLive` (the app went to the background) until
    /// `resumeLiveAsync`. `startLive` checks it at the last moment, because
    /// the connect cycle before it can straddle a pause.
    var inForeground = true
    private var idleWaiters: [CheckedContinuation<Void, Never>] = []

    func finishCycle() {
        busy = false
        signalIdle()
    }

    func signalIdle() {
        guard !busy, liveStartsInFlight == 0 else { return }
        let waiters = idleWaiters
        idleWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }

    /// The Rust client (holds token + vault key + object map in memory).
    var client: SyncClient?

    /// Strong ref to the live listener — Rust holds it across the FFI, so we
    /// must keep it alive ourselves (it in turn holds `self` weakly).
    var liveListener: LiveListener?

    /// The vault root of the current session, stashed at connect so a
    /// session heal can rebuild the client without the Sync view.
    var notesRoot: String?

    /// Guards against re-entrant heal attempts — collection-gone or auth expiry
    /// can surface from both the manual sync path and the live loop at once.
    var healing = false

    /// Which door opened the session in `client`, so `connectHosted` can tell
    /// the session it must not duplicate from the one it must replace. Set only
    /// where a session is adopted, cleared only where one is dropped.
    var sessionMode: SessionMode?

    func localizedStatus(_ localization: Localization) -> String {
        localization.localizedText(statusMessage.path, arguments: statusMessage.arguments)
    }

    func localizedLastError(_ localization: Localization) -> String? {
        lastErrorMessage.map {
            localization.localizedText($0.path, arguments: $0.arguments)
        }
    }

    func localizedLiveError(_ localization: Localization) -> String? {
        liveErrorMessage.map {
            localization.localizedText($0.path, arguments: $0.arguments)
        }
    }

    /// Invoked on the main actor after any completed cycle that changed the
    /// local notes tree. The lossless summary is carried to the note projection
    /// and open-note reconciler; neither re-derives rename/delete intent from
    /// counters or a vault scan.
    var onLocalTreeChanged: ((SyncSummary) -> Void)?

    /// Single reporter for a completed cycle's outcome (docs/spec/sync.md):
    /// clean → just "Sync complete" (never uploaded/downloaded/deleted/conflict
    /// counts); per-item failures → the red error line, using
    /// `failureMessage` (computed in Rust as a diagnostic) selects the error
    /// state; the visible wording comes from the shared language catalog.
    /// Cleared by the next clean cycle.
    ///
    /// A refused write is the one failure that is not a fault: nothing is
    /// broken, the account simply may not write, so the status line says so in
    /// its own words instead of "Sync completed with errors", which sent people
    /// looking for a server problem that was not there (ADR 0003 decision 8).
    /// Rust names the refusal; this only chooses the sentence.
    func applyOutcome(_ s: SyncSummary) {
        lastWriteRefusal = s.writeRefusal
        if let refusal = s.writeRefusal {
            statusMessage = LocalizedMessage(Self.writeRefusalHeadline(refusal))
            lastErrorMessage = LocalizedMessage(Self.writeRefusalExplanation(refusal))
        } else if s.failureMessage != nil {
            statusMessage = LocalizedMessage("sync.status.error")
            lastErrorMessage =
                Self.specificFileFailure(s.failures)
                ?? LocalizedMessage("sync.errors.completedWithErrors")
        } else {
            statusMessage = LocalizedMessage("sync.status.complete")
            lastErrorMessage = nil
        }
    }

    /// How this manager reaches the hosted wizard's state machine. Rust's
    /// `HostedSetupClient` is a handle on this vault's Keychain entries rather
    /// than a session, so building one is cheap and carries nothing between
    /// calls. A property so a test can hand over a stand-in; a build with
    /// hosted sync compiled out has none at all, and every hosted path here
    /// then does nothing.
    var makeHostedSetup: (String) -> HostedSetupClientProtocol? = { notesRoot in
        guard HostedSyncBuild.isEnabled else { return nil }
        return try? HostedSetupClient.hosted(
            secrets: KeychainVaultSecretStore(notesRoot: notesRoot))
    }

    func disconnectForReset() async {
        resetting = true
        if busy || liveStartsInFlight > 0 {
            await withCheckedContinuation { idleWaiters.append($0) }
        }
        await client?.stopLiveAndWait()
        await disconnect()
    }

    func finishReset() { resetting = false }

    func disconnect() async {
        await tearDownSession()
        // Clear the stored password so we don't auto-reconnect after an explicit
        // disconnect.
        Keychain.syncPassword = nil
    }

    /// Ends the session this manager is holding, for real: Rust stops the live
    /// loop and demotes this vault's sync state, and nothing local is left
    /// pointing at a client that is gone. Touches no stored secret — the
    /// explicit `disconnect` adds the password clear, and the hosted switch
    /// leaves it to Rust's `connect_sync`.
    func tearDownSession() async {
        if let c = client { try? await c.disconnect() }  // Rust stops live internally too
        forgetSession()
    }

    /// Drops this manager's view of a session, without touching disk or any
    /// secret — what is left to do once Rust has revoked and demoted one.
    func forgetSession() {
        client = nil
        sessionMode = nil
        connected = false
        live = false
        liveListener = nil
        healing = false  // clear any stalled heal so a future session can heal
        statusMessage = LocalizedMessage("sync.status.notConnected")
        lastErrorMessage = nil
        liveErrorMessage = nil
    }

    func failureMessage(_ error: Error, fallback: String) -> LocalizedMessage {
        Self.isCertificateRejection(describe(error))
            ? LocalizedMessage("sync.errors.certificateNotTrusted")
            : LocalizedMessage(fallback)
    }

    /// rustls prefixes every certificate rejection this way, whatever the
    /// verifier's reason (sync.md).
    static func isCertificateRejection(_ message: String) -> Bool {
        message.contains("invalid peer certificate")
    }

    func describe(_ error: Error) -> String {
        if let e = error as? SyncError {
            switch e {
            case .Http(let m): return "HTTP: \(m)"
            case .Crypto(let m): return "Crypto: \(m)"
            case .Io(let m): return "IO: \(m)"
            case .Auth(let m): return "Auth: \(m)"
            case .CollectionGone(let m): return m
            case .NotConnected: return "Not connected"
            }
        }
        return "\(error)"
    }
}

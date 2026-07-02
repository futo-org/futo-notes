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
    @Published private(set) var connected = false
    @Published private(set) var status = "Not connected"
    @Published private(set) var busy = false
    /// A real pull/push/connect failure — shown in alarming red.
    @Published var lastError: String?

    /// Live-stream (SSE) health, separate from `lastError`. A live-connect/stream
    /// error is NOT a sync failure: the loop reconnects with backoff and the
    /// periodic safety poll keeps reconciling. Kept distinct so a server without
    /// SSE (HTTP 404 on /api/sync/events) or a transient stream drop surfaces as
    /// a muted "live sync unavailable" hint, not a red "your sync broke" alarm.
    @Published private(set) var liveError: String?

    /// Whether the SSE live stream is currently connected.
    @Published private(set) var live = false

    /// The Rust client (holds token + vault key + object map in memory).
    private var client: SyncClient?

    /// Strong ref to the live listener — Rust holds it across the FFI, so we
    /// must keep it alive ourselves (it in turn holds `self` weakly).
    private var liveListener: LiveListener?

    /// The vault root of the current session, stashed at connect so a
    /// collection-gone heal can rebuild the client without the Sync view.
    private var notesRoot: String?

    /// Guards against re-entrant heal attempts — a collection-gone can surface
    /// from both the manual/initial sync path and the live loop at once.
    private var healing = false

    /// Invoked on the main actor after a live pull that changed the vault on
    /// disk (downloaded/deleted > 0). The note list is a separate `NotesStore`,
    /// so the app wires this to `store.reload()` to surface the pulled note
    /// without a manual sync. (Manual `syncNow` reloads via the Sync view.)
    var onLivePull: (() -> Void)?

    private func summarize(_ s: SyncSummary) -> String {
        // Spec (docs/spec/sync.md): a successful sync reports just "Sync
        // complete" — never uploaded/downloaded/deleted/conflict counts.
        "Sync complete"
    }

    /// Validate a user-entered server URL before attempting a connection.
    /// Returns a friendly, actionable message, or nil when acceptable. Catches
    /// the common mistake of omitting the scheme — a bare host like
    /// `notes.example.com` would otherwise fail with an opaque transport error.
    /// Mirrors Android's `SyncManager.validateServerUrl`. → sync.md
    /// Must satisfy the shared case-set in `tests/conformance/server-url.json`
    /// (the source of truth for all three shells' copies of this rule).
    static func validateServerURL(_ url: String) -> String? {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "Enter a server URL." }
        let lower = trimmed.lowercased()
        if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") {
            return "Add http:// or https:// to the start of the server URL."
        }
        return nil
    }

    /// Connect (login + unwrap vault key) then run an initial sync.
    func connectAndSync(notesRoot: String, password: String) async {
        busy = true
        lastError = nil
        liveError = nil
        status = "Connecting…"
        self.notesRoot = notesRoot  // stash for a later collection-gone heal
        defer { busy = false }
        // Reject a schemeless URL up front with an actionable message instead
        // of letting the client fail with an opaque transport error. → sync.md
        if let urlError = SyncManager.validateServerURL(serverURL) {
            lastError = urlError
            status = "Error"
            return
        }
        // Connect with (and persist) the trimmed URL, mirroring Android.
        // Validation trims before the scheme check, so a whitespace-wrapped
        // URL must not reach SyncClient untrimmed — that reintroduces the
        // opaque transport failure the validation exists to prevent. → sync.md
        let normalizedURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(normalizedURL, forKey: "futo.serverURL")
        do {
            let c = SyncClient(notesRoot: notesRoot, serverUrl: normalizedURL)
            let info = try await c.connect(password: password)
            client = c
            connected = true
            // Persist the (now-validated) password so a cold relaunch can
            // auto-reconnect — see `restoreSession`. Cleared on `disconnect`.
            Keychain.syncPassword = password
            status = "Connected (\(info.authMode)) · syncing…"
            let summary = try await c.syncNow()
            status = summarize(summary)
            // Refresh the list if the initial (catch-up) sync pulled changes —
            // covers `restoreSession` on a cold launch, where there's no Sync
            // view to reload the store afterward.
            if summary.downloaded > 0 || summary.deleted > 0 { onLivePull?() }
            await startLive()
        } catch {
            connected = client != nil
            lastError = describe(error)
            status = "Error"
        }
    }

    /// Signal Rust that a local note changed so the live loop debounces and
    /// auto-pushes the edit to peers. Fire-and-forget and non-blocking on the
    /// Rust side — a no-op when not connected / no live task is running. The app
    /// wires this to every `NotesStore` mutation via `NotesStore.onLocalChange`.
    /// Mirrors Android's `SyncManager.noteChanged`.
    func noteChanged() {
        client?.noteChanged()
    }

    /// Run a sync against an already-connected client.
    func syncNow() async {
        guard let c = client else { return }
        busy = true
        lastError = nil
        status = "Syncing…"
        defer { busy = false }
        do {
            let summary = try await c.syncNow()
            status = summarize(summary)
        } catch {
            // The pinned vault was collapsed by the single-vault migration —
            // re-point to the survivor instead of surfacing a dead-end error.
            if isCollectionGone(error) { healCollectionGone(); return }
            lastError = describe(error)
            status = "Error"
        }
    }

    /// Whether a typed sync error is the collection-gone signal (the vault this
    /// client pinned to was collapsed server-side by the single-vault migration).
    private func isCollectionGone(_ error: Error) -> Bool {
        if let e = error as? SyncError, case .CollectionGone = e { return true }
        return false
    }

    /// Heal a collapsed vault: re-point to the surviving canonical vault. A
    /// fresh `connectAndSync` re-runs `connect()` (which re-picks the survivor
    /// via `list_collections`) and the reset→reconcile→push re-uploads our local
    /// notes, so nothing is lost. Uses the password stored at last connect;
    /// no-op if none. Guarded against re-entry.
    private func healCollectionGone() {
        guard !healing, let root = notesRoot, let password = Keychain.syncPassword else { return }
        healing = true
        Task {
            // The dead session's live loop stopped itself (terminal on
            // collection-gone); connectAndSync builds a fresh client + live loop.
            await connectAndSync(notesRoot: root, password: password)
            healing = false
        }
    }

    /// Open the SSE live stream. The Rust task does all the reconnect/backoff/
    /// safety-poll work and reports back via `LiveListener`; `onConnected` flips
    /// `live`. A live-start failure only surfaces as `lastError` — it must not
    /// look like the whole connection failed.
    private func startLive() async {
        guard let c = client else { return }
        let listener = LiveListener(manager: self)
        liveListener = listener
        // A live-start failure is a live-stream-health issue, not a sync
        // failure — route it to the muted `liveError`, never the red `lastError`.
        do { try await c.startLive(listener: listener) }
        catch { liveError = describe(error) }
    }

    /// Re-open the stream after returning to the foreground. No-op unless we have
    /// a connected session that isn't already live (and aren't mid-connect).
    func resumeLiveAsync() {
        guard connected, !live, !busy, client != nil else { return }
        Task { await startLive() }
    }

    /// Pause the stream (app backgrounded). Keeps the session; a fresh `ready` on
    /// resume drives a catch-up pull.
    func pauseLive() {
        client?.stopLive()
        live = false
    }

    /// Auto-reconnect on a cold launch using the password stored at last connect.
    /// No-op if already connected/busy or nothing is stored. Drives the full
    /// connect → initial sync → live path, so a force-quit/relaunch resumes sync
    /// without the user re-entering the password.
    func restoreSession(notesRoot: String) async {
        guard !connected, !busy, let password = Keychain.syncPassword else { return }
        await connectAndSync(notesRoot: notesRoot, password: password)
    }

    // ── Live-listener callbacks (invoked on the main actor by LiveListener) ──

    func applyLiveSummary(_ s: SyncSummary) {
        status = summarize(s)
        lastError = nil
        liveError = nil  // a completed live pull means the stream is healthy
        // A live pull wrote to disk — refresh the note list (only when there's
        // an actual change, to skip needless rescans on no-op pulls).
        if s.downloaded > 0 || s.deleted > 0 { onLivePull?() }
    }

    fileprivate func setLive(_ v: Bool) {
        live = v
        if v { liveError = nil }  // a clean (re)connect clears the live-health hint
    }

    /// Sink for the Rust live loop's per-reconnect errors. Connect/stream
    /// failures (`connect:` / `stream:` — the loop is retrying, the safety poll
    /// still runs) are live-stream health and go to the muted `liveError`.
    /// Anything else is a genuine failure and gets the red `lastError`.
    fileprivate func setLastError(_ m: String) {
        // The live loop hit the collapsed vault and stopped itself (terminal on
        // collection-gone). Re-point to the surviving canonical vault rather
        // than leaving a persistent error until the app restarts.
        if m.contains("collection-gone") {
            healCollectionGone()
            return
        }
        if m.hasPrefix("connect:") || m.hasPrefix("stream:") {
            liveError = m
        } else {
            lastError = m
        }
    }

    func disconnect() async {
        if let c = client { try? await c.disconnect() }  // Rust stops live internally too
        client = nil
        connected = false
        live = false
        liveListener = nil
        // Clear the stored password so we don't auto-reconnect after an explicit
        // disconnect.
        Keychain.syncPassword = nil
        status = "Not connected"
        lastError = nil
        liveError = nil
        healing = false  // clear any stalled heal so a future session can heal
    }

    private func describe(_ error: Error) -> String {
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

/// Receives live-sync events from Rust. NOT `@MainActor`: UniFFI invokes these on
/// a tokio worker thread, so each callback hops to the main actor before touching
/// `SyncManager`'s `@Published` state. `weak manager` breaks the retain cycle
/// (SyncManager → client → (Rust) listener → SyncManager). Never call back into
/// `SyncClient` here (e.g. `status()`) — that would deadlock a runtime worker.
final class LiveListener: SyncEventListener {
    weak var manager: SyncManager?
    init(manager: SyncManager) { self.manager = manager }

    func onSynced(summary: SyncSummary) { Task { @MainActor in manager?.applyLiveSummary(summary) } }
    func onConnected() { Task { @MainActor in manager?.setLive(true) } }
    func onError(message: String) { Task { @MainActor in manager?.setLastError(message) } }
    func onStopped() { Task { @MainActor in manager?.setLive(false) } }
}

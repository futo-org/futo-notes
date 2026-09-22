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
    @Published private(set) var statusMessage = LocalizedMessage("sync.status.notConnected")
    @Published private(set) var busy = false
    /// A real pull/push/connect failure — shown in alarming red.
    @Published private(set) var lastErrorMessage: LocalizedMessage?

    /// Live-stream (SSE) health, separate from the sync error. A live-connect/stream
    /// error is NOT a sync failure: the loop reconnects with backoff and the
    /// periodic safety poll keeps reconciling. Kept distinct so a server without
    /// SSE (HTTP 404 on /api/sync/events) or a transient stream drop surfaces as
    /// a muted "live sync unavailable" hint, not a red "your sync broke" alarm.
    @Published private(set) var liveErrorMessage: LocalizedMessage?

    /// Whether the SSE live stream is currently connected.
    @Published private(set) var live = false

    /// Whether the LAST completed cycle's writes were refused, and which way
    /// (`futo_notes_sync::WriteRefusal`). Held here because this object
    /// outlives the sync sheet, and the whole point is that a refusal arrives
    /// while the person is somewhere else; `HostedSyncSections` hands it to the
    /// hosted model, which turns it into a banner with an action. Never a
    /// latch — every completed cycle writes its own answer, `nil` included.
    @Published private(set) var lastWriteRefusal: WriteRefusal?

    private var resetting = false
    private var liveStartsInFlight = 0
    private var idleWaiters: [CheckedContinuation<Void, Never>] = []

    private func finishCycle() {
        busy = false
        signalIdle()
    }

    private func signalIdle() {
        guard !busy, liveStartsInFlight == 0 else { return }
        let waiters = idleWaiters
        idleWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }

    /// The Rust client (holds token + vault key + object map in memory).
    private var client: SyncClient?

    /// Strong ref to the live listener — Rust holds it across the FFI, so we
    /// must keep it alive ourselves (it in turn holds `self` weakly).
    private var liveListener: LiveListener?

    /// The vault root of the current session, stashed at connect so a
    /// session heal can rebuild the client without the Sync view.
    private var notesRoot: String?

    /// Guards against re-entrant heal attempts — collection-gone or auth expiry
    /// can surface from both the manual sync path and the live loop at once.
    private var healing = false

    /// Which door opened the session in `client`, so `connectHosted` can tell
    /// the session it must not duplicate from the one it must replace. Set only
    /// where a session is adopted, cleared only where one is dropped.
    private var sessionMode: SessionMode?

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
    /// `failureMessage` (computed once in the Rust core so every shell shows
    /// identical wording). Cleared by the next clean cycle.
    ///
    /// A refused write is the one failure that is not a fault: nothing is
    /// broken, the account simply may not write, so the status line says so in
    /// its own words instead of "Sync completed with errors", which sent people
    /// looking for a server problem that was not there (ADR 0003 decision 8).
    /// Rust names the refusal; this only chooses the sentence.
    private func applyOutcome(_ s: SyncSummary) {
        lastWriteRefusal = s.writeRefusal
        if let refusal = s.writeRefusal {
            statusMessage = LocalizedMessage(Self.writeRefusalHeadline(refusal))
            lastErrorMessage = LocalizedMessage(Self.writeRefusalExplanation(refusal))
        } else if s.failureMessage != nil {
            statusMessage = LocalizedMessage("sync.status.error")
            lastErrorMessage = LocalizedMessage("sync.errors.completedWithErrors")
        } else {
            statusMessage = LocalizedMessage("sync.status.complete")
            lastErrorMessage = nil
        }
    }

    /// The short form, for the Settings row that shows sync status at a glance.
    /// `internal` so the unit tests can pin the mapping.
    static func writeRefusalHeadline(_ refusal: WriteRefusal) -> String {
        switch refusal {
        case .subscriptionRequired: "sync.hosted.banner.syncPaused.title"
        case .quotaExceeded: "sync.hosted.banner.vaultFull.title"
        }
    }

    /// The whole sentence, including what still works. Mirrors the desktop
    /// status line's wording exactly — both read the same catalog entry.
    static func writeRefusalExplanation(_ refusal: WriteRefusal) -> String {
        switch refusal {
        case .subscriptionRequired: "sync.errors.writePausedSubscription"
        case .quotaExceeded: "sync.errors.writePausedQuota"
        }
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

    /// Did this cycle change the local notes tree such that the open editor
    /// must reconcile from disk? Peer downloads/deletes are obvious; the subtle
    /// case is a PUSH-side clean merge, which writes merged text to disk but
    /// reports only `uploaded` — the core surfaces those in `localWritesApplied`.
    /// Gating on `downloaded`/`deleted` alone let a stale editor keep a base
    /// whose next autosave clobbered the peer's merged-in edit (F2). A
    /// core-computed decision the shell renders — not re-derived from counts.
    /// Mirrors Android `SyncManager.wroteLocalChanges`.
    static func wroteLocalChanges(_ s: SyncSummary) -> Bool {
        s.downloaded > 0 || s.deleted > 0 || s.localWritesApplied > 0
    }

    // ── Which session wins ──────────────────────────────────────────────
    //
    // Two decisions, both `static` and both pure, so they are pinned by the
    // shared cross-shell case-set in `tests/conformance/sync-session-mode.json`
    // rather than only by whatever a device happened to do. Kotlin carries the
    // same pair (`SyncManager.hostedConnectEntry` / `restoreBranch`).

    /// Which door opened the session this manager is currently holding.
    /// `internal` so the conformance test can name it.
    enum SessionMode {
        case selfHosted
        case hosted
    }

    /// What a hosted connect does about the session already in hand.
    enum HostedConnectEntry {
        /// The wizard re-entering on a session it already has. It fires a
        /// connect whenever it sees an unlocked vault, and a second client
        /// would leave the first one's live loop running.
        case skip
        /// The switch: end the self-hosted session, then connect hosted.
        case replaceSelfHosted
        /// An ordinary connect with nothing in the way.
        case proceed

        var fixtureName: String {
            switch self {
            case .skip: "skip"
            case .replaceSelfHosted: "replaceSelfHosted"
            case .proceed: "proceed"
            }
        }
    }

    /// Mode-aware because it did not used to be: the guard skipped on *any*
    /// live session, and a self-hosted one is not a reason to skip the connect
    /// that is meant to replace it. Completing the wizard over a live password
    /// session left a normal-looking account card reading `0 B of 10 GB used`
    /// with no cycle behind it, and the next launch went back to the old
    /// server (iOS simulator, 2026-09-16). Justin's call the same day:
    /// finishing hosted setup replaces a self-hosted session. → sync.md
    static func hostedConnectEntry(
        connected: Bool, hasClient: Bool, healing: Bool, mode: SessionMode?
    ) -> HostedConnectEntry {
        // A client that is gone cannot be holding a live loop, and a session
        // being healed is being rebuilt — neither is a session to skip for.
        if connected, hasClient, !healing, mode == .hosted { return .skip }
        // `hasClient` and not `connected`: a cycle that failed still leaves the
        // live loop running, and that loop is exactly what must not be orphaned.
        if hasClient, mode == .selfHosted { return .replaceSelfHosted }
        return .proceed
    }

    /// Which credential a cold launch reaches for.
    enum RestoreBranch {
        case hosted
        case selfHosted
        case nothing

        var fixtureName: String {
            switch self {
            case .hosted: "hosted"
            case .selfHosted: "selfHosted"
            case .nothing: "nothing"
            }
        }
    }

    /// Both inputs are local secret-store reads, so this costs no network even
    /// on a launch with none.
    ///
    /// **Holding both is a one-time migration heal that retires itself, not a
    /// change of precedence.** With no hosted vault the password still wins —
    /// that is what keeps a self-hosted device self-hosted, and it is the whole
    /// difference between this and the "just invert the precedence" option that
    /// was rejected for breaking the reverse case identically. Both shells stop
    /// offering the self-hosted fields once hosted sync is set up
    /// (`HostedSyncSections`, `model.screen != .account`), so a device can no
    /// longer arrive at both secrets by any route a person can take; the only
    /// devices that hold both are ones stranded by a build from before a hosted
    /// connect cleared the password. Taking the hosted branch there runs that
    /// clear, after which the state cannot recur — so this branch stops being
    /// reachable on its own rather than needing a flag to switch it off. Do not
    /// "simplify" it into unconditional hosted-first. Justin's call,
    /// 2026-09-16. → sync.md
    static func restoreBranch(hasStoredPassword: Bool, hasHostedVault: Bool) -> RestoreBranch {
        if hasHostedVault { return .hosted }
        if hasStoredPassword { return .selfHosted }
        return .nothing
    }

    /// Connect (login + unwrap vault key) then run an initial sync.
    func connectAndSync(notesRoot: String, password: String) async {
        guard !resetting, !busy else { return }
        busy = true
        lastErrorMessage = nil
        liveErrorMessage = nil
        statusMessage = LocalizedMessage("sync.status.connecting")
        self.notesRoot = notesRoot
        defer { finishCycle() }
        // Reject a schemeless URL up front with an actionable message instead
        // of letting the client fail with an opaque transport error. → sync.md
        if SyncManager.validateServerURL(serverURL) != nil {
            statusMessage = LocalizedMessage("sync.status.error")
            lastErrorMessage =
                serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? LocalizedMessage("sync.errors.enterServerUrl")
                : LocalizedMessage("sync.errors.addServerScheme")
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
            // Persist the (now-validated) password so a cold relaunch can
            // auto-reconnect — see `restoreSession`. Cleared on `disconnect`.
            Keychain.syncPassword = password
            try await afterConnect(
                c,
                mode: .selfHosted,
                status: LocalizedMessage(
                    "sync.status.connectedAndSyncing",
                    arguments: ["authMode": info.authMode]
                ))
        } catch {
            NSLog("[Sync] connect failed: %@", describe(error))
            connected = client != nil
            statusMessage = LocalizedMessage("sync.status.error")
            lastErrorMessage = LocalizedMessage("sync.errors.connectFailed")
        }
    }

    /// The tail every connect shares, whichever door opened the session: adopt
    /// the client, run one ORDINARY cycle, and go live. Hosted and self-hosted
    /// differ only in how the client was authenticated — from here they are the
    /// same `syncNow` path every later trigger goes through, not a second one
    /// written for hosted.
    private func afterConnect(
        _ c: SyncClient, mode: SessionMode, status: LocalizedMessage
    ) async throws {
        client = c
        sessionMode = mode
        connected = true
        statusMessage = status
        let summary = try await c.syncNow()
        applyOutcome(summary)
        // Refresh the list/editor if the initial (catch-up) sync changed
        // the local tree — pulls OR push-side merges (F2). Covers
        // `restoreSession` on a cold launch, where there's no Sync view to
        // project the summary afterward.
        if Self.wroteLocalChanges(summary) { onLocalTreeChanged?(summary) }
        await startLive()
    }

    // ── Hosted sessions ─────────────────────────────────────────────────────

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

    /// Connect the hosted session this device already holds: Rust hands the
    /// saved vault key and session token to the engine, and one ordinary cycle
    /// runs. Called when the wizard reaches `ready` — whichever door got it
    /// there — and at every cold start that finds a saved vault.
    ///
    /// **Nothing is written to `Keychain.syncPassword`.** A hosted device has
    /// no password to store, and storing one would send the next
    /// `restoreSession` down the self-hosted branch with a password no server
    /// accepts.
    func connectHosted(notesRoot: String, setup: HostedSetupClientProtocol) async {
        guard !resetting, !busy else { return }
        let entry = Self.hostedConnectEntry(
            connected: connected, hasClient: client != nil, healing: healing, mode: sessionMode)
        if entry == .skip { return }
        busy = true
        defer { finishCycle() }
        // Finishing hosted setup REPLACES a live self-hosted session, rather
        // than skipping the connect because one is running. The teardown is the
        // real one — Rust stops the live loop and demotes this vault's sync
        // state — because dropping the reference alone leaves an orphaned SSE
        // loop pulling into a vault this device no longer syncs that way.
        // Deliberately not `disconnect()`: that also clears the stored
        // password, and the single owner of that rule is Rust's `connect_sync`
        // below, which clears it only once the hosted session is certain.
        if entry == .replaceSelfHosted { await tearDownSession() }
        lastErrorMessage = nil
        liveErrorMessage = nil
        statusMessage = LocalizedMessage("sync.status.connecting")
        self.notesRoot = notesRoot
        do {
            let c = SyncClient(notesRoot: notesRoot, serverUrl: setup.serverUrl())
            try await setup.connectSync(sync: c)
            try await afterConnect(
                c, mode: .hosted,
                status: LocalizedMessage("sync.status.hostedConnectedAndSyncing"))
        } catch let error as HostedError {
            NSLog("[Sync] hosted connect failed: %@", "\(error)")
            applyHostedConnectFailure(error)
        } catch {
            NSLog("[Sync] hosted connect failed: %@", describe(error))
            connected = client != nil
            statusMessage = LocalizedMessage("sync.status.error")
            lastErrorMessage = LocalizedMessage("sync.errors.connectFailed")
        }
    }

    /// A hosted connect that did not land is usually nothing to alarm anyone
    /// about. `NotSignedIn` and `VaultLocked` mean the wizard is not finished —
    /// the ordinary state of a device that never set hosted sync up — so they
    /// read as not connected. A transport failure means the phone is offline:
    /// the two secrets are still good and the next foreground or session heal
    /// retries, so it takes the muted live line rather than the red one and
    /// throws nothing away.
    private func applyHostedConnectFailure(_ error: HostedError) {
        connected = client != nil
        switch error {
        case .NotSignedIn, .VaultLocked:
            statusMessage = LocalizedMessage("sync.status.notConnected")
        case .Network:
            statusMessage = LocalizedMessage("sync.status.notConnected")
            liveErrorMessage = LocalizedMessage("sync.errors.hostedOffline")
        default:
            statusMessage = LocalizedMessage("sync.status.error")
            lastErrorMessage = LocalizedMessage("sync.errors.connectFailed")
        }
    }

    /// Hosted sign out, routed through this manager so the session Rust revokes
    /// is the one actually running. `sign_out` stops live sync and demotes this
    /// vault's state through the handle it is given — handed a throwaway, the
    /// live loop would outlive the session it belongs to.
    func signOutHosted(notesRoot: String, setup: HostedSetupClientProtocol) async throws {
        let target = client ?? SyncClient(notesRoot: notesRoot, serverUrl: setup.serverUrl())
        // Whichever way this ends, Rust forgot the secrets and demoted the
        // vault before it could throw, so the manager must not go on believing
        // it holds a session.
        defer { forgetSession() }
        try await setup.signOut(sync: target)
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
        guard !resetting, !busy else { return }
        guard let c = client else { return }
        busy = true
        lastErrorMessage = nil
        statusMessage = LocalizedMessage("sync.status.syncing")
        defer { finishCycle() }
        do {
            let summary = try await c.syncNow()
            applyOutcome(summary)
            if Self.wroteLocalChanges(summary) { onLocalTreeChanged?(summary) }
        } catch {
            // Re-login for both a collapsed vault and an expired bearer token.
            // connect() reuses the persisted cursor/map for the same vault, so
            // auth expiry stays incremental instead of forcing a reconcile.
            if isRecoverableSessionError(error) {
                healSession()
                return
            }
            NSLog("[Sync] sync failed: %@", describe(error))
            statusMessage = LocalizedMessage("sync.status.error")
            lastErrorMessage = LocalizedMessage("sync.errors.syncFailed")
        }
    }

    private func isRecoverableSessionError(_ error: Error) -> Bool {
        guard let e = error as? SyncError else { return false }
        switch e {
        case .Auth, .CollectionGone: return true
        default: return false
        }
    }

    /// Re-login with the stored password to recover an expired session or
    /// collapsed vault without deleting state. Guarded against re-entry. → sync.md
    private func healSession() {
        guard !resetting else { return }
        guard !healing else { return }
        guard let root = notesRoot else {
            reportUnavailableSessionRecovery()
            return
        }
        healing = true
        client?.stopLive()
        Task {
            // The dead session's live loop stopped itself; both branches build a
            // fresh authenticated client + live loop without deleting state.
            if let password = Keychain.syncPassword {
                await connectAndSync(notesRoot: root, password: password)
            } else if let setup = makeHostedSetup(root), await hasSavedVault(setup) {
                // A hosted session rebuilt from the same two secrets. A token
                // the server no longer accepts is a trip to the browser, which
                // Rust arranges by dropping it — the wizard then answers
                // `signIn` and the vault key stays where it is.
                await connectHosted(notesRoot: root, setup: setup)
            } else {
                reportUnavailableSessionRecovery()
            }
            healing = false
        }
    }

    private func reportUnavailableSessionRecovery() {
        statusMessage = LocalizedMessage("sync.status.error")
        lastErrorMessage = LocalizedMessage("sync.errors.previousFailure")
    }

    /// Does this vault have hosted secrets to resume? A local Keychain read in
    /// Rust, never a request — which is what lets boot restore ask it before it
    /// has a network, and treat a refusal to answer as "not hosted".
    private func hasSavedVault(_ setup: HostedSetupClientProtocol) async -> Bool {
        ((try? await setup.hasSavedVault()) ?? false)
    }

    /// Open the SSE live stream. The Rust task does all the reconnect/backoff/
    /// safety-poll work and reports back via `LiveListener`; `onConnected` flips
    /// `live`. A live-start failure only surfaces as the sync error line — it must not
    /// look like the whole connection failed.
    private func startLive() async {
        guard !resetting else { return }
        liveStartsInFlight += 1
        defer {
            liveStartsInFlight -= 1
            signalIdle()
        }
        guard let c = client else { return }
        let listener = LiveListener(manager: self)
        liveListener = listener
        // A live-start failure is a live-stream-health issue, not a sync
        // failure — route it to the muted live error line, never the red sync error line.
        do {
            try await c.startLive(listener: listener)
        } catch {
            NSLog("[Sync] live start failed: %@", describe(error))
            liveErrorMessage = LocalizedMessage("sync.errors.liveUnavailable")
        }
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
        guard !resetting else { return }
        client?.stopLive()
        live = false
    }

    /// Auto-reconnect on a cold launch. No-op if already connected/busy or this
    /// device has nothing saved. Drives the full connect → initial sync → live
    /// path, so a force-quit and relaunch resumes sync **without Settings ever
    /// being opened**.
    ///
    /// A self-hosted vault is the one with a password to reconnect with; a
    /// hosted vault has none and is recognised instead by the two secrets Rust
    /// saved. Both are local reads — no request of any kind — so a launch with
    /// no network still knows which kind of vault this is.
    ///
    /// `restoreBranch` owns the choice, including the one device that answers
    /// to both; read its doc before changing the order here.
    func restoreSession(notesRoot: String) async {
        guard !connected, !busy else { return }
        let setup = makeHostedSetup(notesRoot)
        let hasHostedVault = if let setup { await hasSavedVault(setup) } else { false }
        switch Self.restoreBranch(
            hasStoredPassword: Keychain.syncPassword != nil, hasHostedVault: hasHostedVault)
        {
        case .hosted:
            guard let setup else { return }
            await connectHosted(notesRoot: notesRoot, setup: setup)
        case .selfHosted:
            guard let password = Keychain.syncPassword else { return }
            await connectAndSync(notesRoot: notesRoot, password: password)
        case .nothing:
            return
        }
    }

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

    /// Sink for the Rust live loop's per-reconnect errors. Connect/stream
    /// failures (`connect:` / `stream:` — the loop is retrying, the safety poll
    /// still runs) are live-stream health and go to the muted live error line.
    /// Anything else is a genuine failure and gets the red sync error line.
    fileprivate func setLastError(_ m: String) {
        // Auth expiry and collection-gone are terminal for the old live loop,
        // but recoverable from the securely stored password.
        if m.contains("collection-gone") || m.hasPrefix("auth:") {
            healSession()
            return
        }
        if m.hasPrefix("connect:") || m.hasPrefix("stream:") {
            liveErrorMessage = LocalizedMessage("sync.errors.liveUnavailable")
        } else {
            lastErrorMessage = LocalizedMessage("sync.errors.syncFailed")
        }
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
    private func tearDownSession() async {
        if let c = client { try? await c.disconnect() }  // Rust stops live internally too
        forgetSession()
    }

    /// Drops this manager's view of a session, without touching disk or any
    /// secret — what is left to do once Rust has revoked and demoted one.
    private func forgetSession() {
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

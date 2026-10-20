import Foundation

extension SyncManager {
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
            lastErrorMessage = failureMessage(error, fallback: "sync.errors.syncFailed")
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
    func healSession() {
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
    func hasSavedVault(_ setup: HostedSetupClientProtocol) async -> Bool {
        ((try? await setup.hasSavedVault()) ?? false)
    }

    /// Open the SSE live stream. The Rust task does all the reconnect/backoff/
    /// safety-poll work and reports back via `LiveListener`; `onConnected` flips
    /// `live`. A live-start failure only surfaces as the sync error line — it must not
    /// look like the whole connection failed.
    func startLive() async {
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
}

import Foundation

extension SyncManager {
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
            lastErrorMessage = failureMessage(error, fallback: "sync.errors.connectFailed")
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
}

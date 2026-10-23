package com.futo.notes

import com.futo.notes.localization.LocalizedMessage
import com.futo.notes.SyncManager.Companion.hostedConnectEntry
import com.futo.notes.SyncManager.Companion.needsPlatformTrust
import com.futo.notes.SyncManager.Companion.validateServerUrl
import com.futo.notes.SyncManager.Companion.wroteLocalChanges
import com.futo.notes.SyncManager.HostedConnectEntry
import com.futo.notes.SyncManager.SessionMode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.futo_notes_ffi.HostedException
import uniffi.futo_notes_ffi.HostedSetupClientInterface
import uniffi.futo_notes_ffi.SyncClient

/** Connect (login + unwrap vault key), run an initial sync, then go live. */
suspend fun SyncManager.connectAndSync(notesRoot: String, password: String) {
    storageMigrationGate.runAccessIfAvailable {
        connectAndSyncLocked(notesRoot, password)
    }
}

/** Connect while [storageMigrationGate] is already held by the caller. */
internal suspend fun SyncManager.connectAndSyncLocked(notesRoot: String, password: String) {
    // Be forgiving about whitespace, but catch the common mistake of a
    // schemeless URL up front with an actionable message instead of letting
    // it surface as a cryptic transport error [sync.md].
    val url = serverUrl.trim()
    validateServerUrl(url)?.let { error ->
        lastErrorDiagnostic = error
        statusMessage = LocalizedMessage("sync.status.error")
        errorMessage = if (url.isEmpty()) {
            LocalizedMessage("sync.errors.enterServerUrl")
        } else {
            LocalizedMessage("sync.errors.addServerScheme")
        }
        return
    }
    if (needsPlatformTrust(url) && !PlatformTrust.isBound) {
        statusMessage = LocalizedMessage("sync.status.error")
        errorMessage = LocalizedMessage("sync.errors.secureConnectionUnavailable")
        return
    }
    busy = true
    lastErrorDiagnostic = null
    errorMessage = null
    statusMessage = LocalizedMessage("sync.status.connecting")
    this.notesRoot = notesRoot
    try {
        val c = SyncClient(notesRoot, url)
        val info = c.connect(password)
        // Persist the session so the next launch reconnects silently
        // [sync.md:91]. Keystore + prefs I/O — off the main thread.
        withContext(Dispatchers.IO) {
            secure?.storePassword(password)
            prefs?.edit()?.putString(Prefs.SYNC_SERVER_URL, url)?.apply()
        }
        afterConnect(
            c,
            SessionMode.SELF_HOSTED,
            LocalizedMessage(
                "sync.status.connectedAndSyncing",
                mapOf("authMode" to info.authMode),
            ),
        )
    } catch (e: Exception) {
        connected = client != null
        lastErrorDiagnostic = describe(e)
        statusMessage = LocalizedMessage("sync.status.error")
        errorMessage = failureMessage(e, "sync.errors.connectFailed")
    } finally {
        busy = false
    }
}

/**
 * The tail every connect shares, whichever door opened the session: adopt
 * the client, run one ORDINARY cycle, and go live. Hosted and self-hosted
 * differ only in how the client was authenticated — from here they are the
 * same `syncNow` path every later trigger goes through, not a second one
 * written for hosted. Mirrors iOS `SyncManager.afterConnect`.
 */
internal suspend fun SyncManager.afterConnect(c: SyncClient, mode: SessionMode, status: LocalizedMessage) {
    client = c
    sessionMode = mode
    connected = true
    statusMessage = status
    val initial = c.syncNow()
    applyOutcome(initial)
    // Refresh the list/editor if the initial (catch-up) sync changed
    // the local tree — pulls OR push-side merges (F2).
    if (wroteLocalChanges(initial)) onLocalTreeChanged?.invoke(initial)
    // Not if the app went to the background during that cycle: the next
    // foreground's resumeLiveAsync goes live instead.
    startLiveInForeground { c.startLive(LiveListener()) } // onConnected flips `live`
}

// ── Hosted sessions ─────────────────────────────────────────────────────

/**
 * Connect the hosted session this device already holds: Rust hands the saved
 * vault key and session token to the engine, and one ordinary cycle runs.
 * Called when the wizard reaches `READY` — whichever door got it there — and
 * at every cold start that finds a saved vault.
 *
 * **Nothing is written to [SecureStore.storePassword].** A hosted device has
 * no password to store, and storing one would send the next
 * [restoreSession] down the self-hosted branch with a password no server
 * accepts. Mirrors iOS `SyncManager.connectHosted`.
 */
suspend fun SyncManager.connectHosted(notesRoot: String, setup: HostedSetupClientInterface) {
    storageMigrationGate.runAccessIfAvailable {
        connectHostedLocked(notesRoot, setup)
    }
}

internal suspend fun SyncManager.connectHostedLocked(
    notesRoot: String,
    setup: HostedSetupClientInterface,
) {
    val entry = hostedConnectEntry(connected, client != null, healing, sessionMode)
    if (entry == HostedConnectEntry.SKIP) return
    busy = true
    // Finishing hosted setup REPLACES a live self-hosted session, rather
    // than skipping the connect because one is running. The teardown is the
    // real one — Rust stops the live loop and demotes this vault's sync
    // state — because dropping the reference alone leaves an orphaned SSE
    // loop pulling into a vault this device no longer syncs that way.
    // Deliberately not [disconnect]: that also clears the stored password,
    // and the single owner of that rule is Rust's `connect_sync` below,
    // which clears it only once the hosted session is certain.
    if (entry == HostedConnectEntry.REPLACE_SELF_HOSTED) tearDownSession()
    lastErrorDiagnostic = null
    errorMessage = null
    statusMessage = LocalizedMessage("sync.status.connecting")
    this.notesRoot = notesRoot
    try {
        val c = SyncClient(notesRoot, setup.serverUrl())
        setup.connectSync(c)
        afterConnect(
            c, SessionMode.HOSTED, LocalizedMessage("sync.status.hostedConnectedAndSyncing"))
    } catch (e: HostedException) {
        lastErrorDiagnostic = describe(e)
        applyHostedConnectFailure(e)
    } catch (e: Exception) {
        connected = client != null
        lastErrorDiagnostic = describe(e)
        statusMessage = LocalizedMessage("sync.status.error")
        errorMessage = LocalizedMessage("sync.errors.connectFailed")
    } finally {
        busy = false
    }
}

/**
 * A hosted connect that did not land is usually nothing to alarm anyone
 * about. `NotSignedIn` and `VaultLocked` mean the wizard is not finished —
 * the ordinary state of a device that never set hosted sync up — so they
 * read as not connected. A transport failure means the phone is offline:
 * the two secrets are still good and the next foreground or session heal
 * retries, so it takes the muted live line rather than the red one and
 * throws nothing away. Mirrors iOS `applyHostedConnectFailure`.
 */
internal fun SyncManager.applyHostedConnectFailure(e: HostedException) {
    connected = client != null
    when (e) {
        is HostedException.NotSignedIn, is HostedException.VaultLocked -> {
            statusMessage = LocalizedMessage("sync.status.notConnected")
        }
        is HostedException.Network -> {
            statusMessage = LocalizedMessage("sync.status.notConnected")
            errorMessage = LocalizedMessage("sync.errors.hostedOffline")
        }
        else -> {
            statusMessage = LocalizedMessage("sync.status.error")
            errorMessage = LocalizedMessage("sync.errors.connectFailed")
        }
    }
}

/**
 * Hosted sign out, routed through this manager so the session Rust revokes
 * is the one actually running. `signOut` stops live sync and demotes this
 * vault's state through the handle it is given — handed a throwaway, the
 * live loop would outlive the session it belongs to.
 */
suspend fun SyncManager.signOutHosted(notesRoot: String, setup: HostedSetupClientInterface) {
    val target = client ?: SyncClient(notesRoot, setup.serverUrl())
    try {
        setup.signOut(target)
    } finally {
        // Whichever way this ended, Rust forgot the secrets and demoted the
        // vault before it could throw, so the manager must not go on
        // believing it holds a session.
        forgetSession()
    }
}

/**
 * Does this vault have hosted secrets to resume? A local Keystore read in
 * Rust, never a request — which is what lets boot restore ask it before it
 * has a network, and treat a refusal to answer as "not hosted".
 */
internal suspend fun SyncManager.hasSavedVault(setup: HostedSetupClientInterface): Boolean =
    runCatching { setup.hasSavedVault() }.getOrDefault(false)

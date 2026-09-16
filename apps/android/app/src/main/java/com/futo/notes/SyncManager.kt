package com.futo.notes

import android.content.SharedPreferences
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.futo.notes.storage.StorageMigrationGate
import com.futo.notes.localization.LocalizedMessage
import com.futo.notes.localization.Localization
import com.futo.notes.sync.hosted.HostedSyncBuild
import com.futo.notes.sync.hosted.KeystoreVaultSecretStore
import uniffi.futo_notes_ffi.HostedException
import uniffi.futo_notes_ffi.HostedSetupClient
import uniffi.futo_notes_ffi.HostedSetupClientInterface
import uniffi.futo_notes_ffi.SyncClient
import uniffi.futo_notes_ffi.SyncEventListener
import uniffi.futo_notes_ffi.SyncException
import uniffi.futo_notes_ffi.SyncSummary

/**
 * Thin wrapper over the Rust `SyncClient` (UniFFI) — the counterpart of the iOS
 * `SyncManager.swift`. All sync/auth/E2EE logic lives in Rust; this drives it
 * and surfaces status to Compose.
 *
 * Live sync: after connecting, [SyncClient.startLive] runs a Rust background
 * task that opens the server's SSE stream and pulls on every `ready`/`change`
 * (plus a safety poll), reconnecting with backoff. It reports back through
 * [SyncEventListener], whose callbacks fire on a tokio worker thread — so each
 * hops to the main thread via [scope] before touching Compose state.
 *
 * Session persistence [sync.md:91]: a successful connect stores the server URL
 * in plain prefs and the password Keystore-encrypted via [SecureStore];
 * [restoreSession] reconnects silently at startup. Only an explicit
 * [disconnect] wipes the stored password — transient failures keep it.
 */
class SyncManager(
    private val secure: SecureStore? = null,
    private val prefs: SharedPreferences? = null,
) {
    var serverUrl by mutableStateOf(
        // First-launch seed: the emulator dev server in debug, empty in release.
        // Shipping should start with no server until the user enters one (the
        // emulator loopback default is meaningless off a dev machine). Mirrors
        // CrashReporter.kt's BuildConfig.DEBUG gate. The runtime-editable/persisted value
        // (SyncScreen + prefs) is unchanged — this only changes the seed.
        prefs?.getString(Prefs.SYNC_SERVER_URL, defaultServer()) ?: defaultServer(),
    )
    var connected by mutableStateOf(false)
        private set
    var statusMessage by mutableStateOf(LocalizedMessage("sync.status.notConnected"))
        private set
    var busy by mutableStateOf(false)
        private set
    var lastErrorDiagnostic: String? = null
        private set
    private var errorMessage by mutableStateOf<LocalizedMessage?>(null)

    fun localizedStatus(localization: Localization): String =
        localization.localizedText(statusMessage.path, statusMessage.arguments)

    fun localizedError(localization: Localization): String? = errorMessage?.let {
        localization.localizedText(it.path, it.arguments)
    }

    /** Whether the SSE live stream is currently connected. */
    var live by mutableStateOf(false)
        private set

    /** Invoked on the main thread after a sync that changed the vault on disk.
     *  The complete summary lets [NotesStore] project only affected rows and
     *  lets the open editor render the engine's disposition. */
    var onLocalTreeChanged: ((SyncSummary) -> Unit)? = null

    private var client: SyncClient? = null

    /** Vault root of the current session, stashed at connect so an expired or
     *  collapsed session can be rebuilt without the Sync screen. */
    private var notesRoot: String? = null

    /** Guards against re-entrant heal attempts — collection-gone or auth expiry
     *  can surface from both the manual sync path and the live loop at once. */
    private var healing = false

    /** Drains connect/heal/manual/resume work before a vault migration starts
     * and rejects any new sync work until the old vault is resumed or the app
     * restarts on the migrated root. */
    private val storageMigrationGate = StorageMigrationGate()

    /** Marshals Rust live-sync callbacks onto the main thread. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** Receives live-sync events from Rust (on a tokio thread → hop to main). */
    private inner class LiveListener : SyncEventListener {
        override fun onSynced(summary: SyncSummary) {
            scope.launch {
                // Success reports just "Sync complete" — never the
                // uploaded/downloaded/deleted/conflict counts [sync.md]. A cycle
                // that COMPLETED with per-item failures (uploads/deletes that
                // didn't reach the server) is not success — route it to the
                // red error line instead [sync.md].
                applyOutcome(summary)
                // A live cycle wrote to disk — refresh the list + open editor
                // (skip no-op pulls). Includes push-side merges (F2).
                if (wroteLocalChanges(summary)) onLocalTreeChanged?.invoke(summary)
            }
        }
        override fun onConnected() {
            scope.launch { live = true }
        }
        override fun onError(message: String) {
            scope.launch {
                handleLiveError(message)
            }
        }
        override fun onStopped() {
            scope.launch { live = false }
        }
    }

    /** Connect (login + unwrap vault key), run an initial sync, then go live. */
    suspend fun connectAndSync(notesRoot: String, password: String) {
        storageMigrationGate.runAccessIfAvailable {
            connectAndSyncLocked(notesRoot, password)
        }
    }

    /** Connect while [storageMigrationGate] is already held by the caller. */
    private suspend fun connectAndSyncLocked(notesRoot: String, password: String) {
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
                LocalizedMessage(
                    "sync.status.connectedAndSyncing",
                    mapOf("authMode" to info.authMode),
                ),
            )
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
     * The tail every connect shares, whichever door opened the session: adopt
     * the client, run one ORDINARY cycle, and go live. Hosted and self-hosted
     * differ only in how the client was authenticated — from here they are the
     * same `syncNow` path every later trigger goes through, not a second one
     * written for hosted. Mirrors iOS `SyncManager.afterConnect`.
     */
    private suspend fun afterConnect(c: SyncClient, status: LocalizedMessage) {
        client = c
        connected = true
        statusMessage = status
        val initial = c.syncNow()
        applyOutcome(initial)
        // Refresh the list/editor if the initial (catch-up) sync changed
        // the local tree — pulls OR push-side merges (F2).
        if (wroteLocalChanges(initial)) onLocalTreeChanged?.invoke(initial)
        c.startLive(LiveListener()) // onConnected flips `live` when the stream is up
    }

    // ── Hosted sessions ─────────────────────────────────────────────────────

    /**
     * How this manager reaches the hosted wizard's state machine. Rust's
     * `HostedSetupClient` is a handle on this vault's Keystore entries rather
     * than a session, so building one is cheap and carries nothing between
     * calls. A property so a JVM test can hand over a stand-in with no native
     * library behind it; a build with hosted sync compiled out has none at all,
     * and every hosted path here then does nothing.
     */
    var makeHostedSetup: (String) -> HostedSetupClientInterface? = { notesRoot ->
        val store = secure
        if (!HostedSyncBuild.isEnabled || store == null) {
            null
        } else {
            runCatching {
                HostedSetupClient.hosted(KeystoreVaultSecretStore(store, notesRoot))
            }.getOrNull()
        }
    }

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
    suspend fun connectHosted(notesRoot: String, setup: HostedSetupClientInterface) {
        storageMigrationGate.runAccessIfAvailable {
            connectHostedLocked(notesRoot, setup)
        }
    }

    private suspend fun connectHostedLocked(
        notesRoot: String,
        setup: HostedSetupClientInterface,
    ) {
        // Already syncing this vault, and not rebuilding a dead session: the
        // wizard starts a connect whenever it sees an unlocked vault, which on
        // a restart is after boot restore connected one — and a second client
        // would leave the first one's live loop running.
        if (connected && client != null && !healing) return
        busy = true
        lastErrorDiagnostic = null
        errorMessage = null
        statusMessage = LocalizedMessage("sync.status.connecting")
        this.notesRoot = notesRoot
        try {
            val c = SyncClient(notesRoot, setup.serverUrl())
            setup.connectSync(c)
            afterConnect(c, LocalizedMessage("sync.status.hostedConnectedAndSyncing"))
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
    private fun applyHostedConnectFailure(e: HostedException) {
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
    suspend fun signOutHosted(notesRoot: String, setup: HostedSetupClientInterface) {
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
    private suspend fun hasSavedVault(setup: HostedSetupClientInterface): Boolean =
        runCatching { setup.hasSavedVault() }.getOrDefault(false)

    suspend fun syncNow() {
        storageMigrationGate.runAccessIfAvailable {
            val c = client ?: return@runAccessIfAvailable
            busy = true
            lastErrorDiagnostic = null
            errorMessage = null
            statusMessage = LocalizedMessage("sync.status.syncing")
            try {
                val summary = c.syncNow()
                applyOutcome(summary)
                if (wroteLocalChanges(summary)) onLocalTreeChanged?.invoke(summary)
            } catch (e: Exception) {
                // Re-login for both a collapsed vault and an expired bearer token.
                // The same-vault path keeps the persisted cursor/object map, so
                // token expiry does not trigger a full reconcile.
                if (isRecoverableSessionError(e)) {
                    healSession(describe(e))
                } else {
                    lastErrorDiagnostic = describe(e)
                    statusMessage = LocalizedMessage("sync.status.error")
                    errorMessage = LocalizedMessage("sync.errors.syncFailed")
                }
            } finally {
                busy = false
            }
        }
    }

    private fun isRecoverableSessionError(e: Exception): Boolean =
        e is SyncException.Auth || e is SyncException.CollectionGone

    /** Re-login with the stored password to recover an expired session or
     *  collapsed vault without deleting state. Guarded against re-entry;
     *  mirrors iOS `healSession`. → sync.md */
    private fun healSession(fallbackMessage: String) {
        if (healing || storageMigrationGate.isMigrationStarted) return
        val root = notesRoot
        if (root == null) {
            reportUnavailableSessionRecovery(fallbackMessage)
            return
        }
        healing = true
        client?.stopLive()
        scope.launch {
            try {
                storageMigrationGate.runAccessIfAvailable {
                    val password = withContext(Dispatchers.IO) {
                        runCatching { secure?.loadPassword() }.getOrNull()
                    }
                    // The dead session's live loop stopped itself; both branches
                    // rebuild an authenticated client while still holding the
                    // operation gate.
                    if (password != null) {
                        connectAndSyncLocked(root, password)
                        return@runAccessIfAvailable
                    }
                    // A hosted session rebuilt from the same two secrets. A
                    // token the server no longer accepts is a trip to the
                    // browser, which Rust arranges by dropping it — the wizard
                    // then answers SIGN_IN and the vault key stays where it is.
                    val setup = makeHostedSetup(root)
                    if (setup == null || !hasSavedVault(setup)) {
                        reportUnavailableSessionRecovery(fallbackMessage)
                        return@runAccessIfAvailable
                    }
                    connectHostedLocked(root, setup)
                }
            } finally {
                // Also release when migration began before this queued heal
                // acquired the operation gate, or when the task is cancelled.
                healing = false
            }
        }
    }

    internal fun handleLiveError(message: String) {
        // Auth expiry and collection-gone are terminal for the old live loop,
        // but recoverable from the securely stored password.
        if (shouldHealLiveError(message)) {
            healSession(message)
        } else {
            lastErrorDiagnostic = message
            errorMessage = LocalizedMessage("sync.errors.liveUnavailable")
        }
    }

    private fun reportUnavailableSessionRecovery(message: String) {
        lastErrorDiagnostic = message
        statusMessage = LocalizedMessage("sync.status.error")
        errorMessage = LocalizedMessage("sync.errors.previousFailure")
    }

    /** Single reporter for a completed cycle's outcome [sync.md]: clean →
     *  "Sync complete" (no counts); per-item failures → the red error line,
     *  using `failureMessage` (computed once in the Rust core so every shell
     *  shows identical wording). Cleared by the next clean cycle. */
    internal fun applyOutcome(summary: SyncSummary) {
        val message = summary.failureMessage
        if (message != null) {
            lastErrorDiagnostic = message
            statusMessage = LocalizedMessage("sync.status.error")
            errorMessage = LocalizedMessage("sync.errors.completedWithErrors")
        } else {
            lastErrorDiagnostic = null
            statusMessage = LocalizedMessage("sync.status.complete")
            errorMessage = null
        }
    }

    /** Signal Rust that a local note changed so the live loop debounces and
     *  auto-pushes the edit to peers. Fire-and-forget and non-blocking on the
     *  Rust side — a no-op when not connected / no live task is running. The
     *  Activity wires this to every [NotesStore] mutation via
     *  [NotesStore.onLocalChange]. Mirrors the iOS `SyncManager.noteChanged`. */
    fun noteChanged() {
        if (!storageMigrationGate.isMigrationStarted) client?.noteChanged()
    }

    /** Re-open the live stream after returning to the foreground (no-op if not
     *  connected or already live). Fire-and-forget from the Activity lifecycle. */
    fun resumeLiveAsync() {
        scope.launch {
            storageMigrationGate.runAccessIfAvailable {
                val c = client ?: return@runAccessIfAvailable
                if (!connected || live) return@runAccessIfAvailable
                try {
                    c.startLive(LiveListener())
                } catch (e: Exception) {
                    lastErrorDiagnostic = describe(e)
                    errorMessage = LocalizedMessage("sync.errors.liveUnavailable")
                }
            }
        }
    }

    /** Tear down the live stream (e.g. app backgrounded). Keeps the session. */
    fun pauseLive() {
        // Storage migration owns a graceful stop. An onStop callback landing
        // between the synchronous latch and quiescence must not abort that task.
        if (storageMigrationGate.isMigrationStarted) return
        client?.stopLive()
        live = false
    }

    /** Synchronously reject new sync work before migration starts. The later
     * suspend step drains work and performs a graceful stop. */
    fun beginStorageMigration() {
        storageMigrationGate.beginMigration()
    }

    /** Stop live sync and wait for any connect/manual cycle already in flight. */
    suspend fun quiesceForStorageMigration() {
        storageMigrationGate.runMigration {
            client?.stopLiveAndWait()
            live = false
        }
    }

    /** Re-enable the old session when vault migration or preference commit fails. */
    fun resumeAfterStorageMigrationFailure() {
        storageMigrationGate.resume()
        resumeLiveAsync()
    }

    /** Silent reconnect with the persisted session at startup [sync.md:91].
     *  Fire-and-forget, off-main — never gates render (M1). Failures surface via
     *  [statusMessage]/[lastErrorDiagnostic] but do NOT wipe what is stored (the
     *  server may simply be unreachable); only [disconnect] clears the password,
     *  and only an explicit sign out clears the hosted secrets.
     *
     *  The password path comes first, because a vault set up against someone's
     *  own server is the one with a password to reconnect with. A hosted vault
     *  has none — it is recognised by the two secrets Rust saved, read from the
     *  Keystore with no request, so a launch with no network still knows which
     *  kind of vault this is, and a restart resumes sync **without Settings
     *  ever being opened**. → sync.md */
    fun restoreSession(notesRoot: String) {
        scope.launch {
            storageMigrationGate.runAccessIfAvailable {
                if (connected) return@runAccessIfAvailable
                val password = withContext(Dispatchers.IO) {
                    runCatching { secure?.loadPassword() }.getOrNull()
                }
                if (password != null) {
                    connectAndSyncLocked(notesRoot, password)
                    return@runAccessIfAvailable
                }
                val setup = makeHostedSetup(notesRoot) ?: return@runAccessIfAvailable
                if (!hasSavedVault(setup)) return@runAccessIfAvailable
                connectHostedLocked(notesRoot, setup)
            }
        }
    }

    suspend fun disconnectForReset() {
        storageMigrationGate.beginMigration()
        storageMigrationGate.runMigration {
            client?.stopLiveAndWait()
            disconnect()
        }
    }

    fun finishReset() { storageMigrationGate.resume() }

    suspend fun disconnect() {
        try { client?.disconnect() } catch (_: Exception) {} // also stops live in Rust
        forgetSession()
        // Explicit disconnect is the ONLY place the stored password is wiped.
        withContext(Dispatchers.IO) { runCatching { secure?.clearPassword() } }
    }

    /** Drops this manager's view of a session, without touching disk or any
     *  secret — what is left to do once Rust has revoked and demoted one. */
    private fun forgetSession() {
        client = null
        connected = false
        live = false
        healing = false  // clear any stalled heal so a future session can heal
        lastErrorDiagnostic = null
        statusMessage = LocalizedMessage("sync.status.notConnected")
        errorMessage = null
    }

    private fun describe(e: Exception): String = when (e) {
        is SyncException.Http -> "HTTP: ${e.message}"
        is SyncException.Crypto -> "Crypto: ${e.message}"
        is SyncException.Io -> "IO: ${e.message}"
        is SyncException.Auth -> "Auth: ${e.message}"
        is SyncException.CollectionGone -> e.message ?: "collection-gone"
        is SyncException.NotConnected -> "Not connected"
        else -> e.message ?: e.toString()
    }

    // Visible for testing: the boolean-driven seed selection is pure (no
    // BuildConfig), so the SyncManagerDefaultsTest unit test can pin both
    // branches. `defaultServer()` wires in the real BuildConfig.DEBUG.
    internal companion object {
        const val DEFAULT_SERVER = "http://10.0.2.2:3005" // emulator → host loopback (debug only)

        /** First-launch seed for [serverUrl]: the emulator dev server in debug,
         *  empty in release (a shipping build starts with no server until the
         *  user enters one). */
        fun defaultServer(): String = defaultServer(BuildConfig.DEBUG)

        /** Pure seed selection — testable without BuildConfig. */
        internal fun defaultServer(isDebug: Boolean): String =
            if (isDebug) DEFAULT_SERVER else ""

        /** Did this cycle change the local notes tree such that the open editor
         *  must reconcile from disk? Peer downloads and deletes are obvious; the
         *  subtle case is a PUSH-side clean merge, which writes merged text to
         *  disk but reports only `uploaded` — the core surfaces those in
         *  `localWritesApplied`. Gating on `downloaded`/`deleted` alone let the
         *  editor keep a stale base whose next autosave clobbered the peer's
         *  merged-in edit (F2). This is a core-computed decision the shell
         *  renders — never re-derived from the semantic counts. */
        internal fun wroteLocalChanges(summary: SyncSummary): Boolean =
            summary.downloaded > 0u || summary.deleted > 0u || summary.localWritesApplied > 0u

        /** Validate a user-entered server URL before attempting a connection.
         *  Returns a friendly, actionable error message, or `null` when the URL
         *  is acceptable. Catches the common mistake of omitting the scheme — a
         *  bare host like `notes.example.com` would otherwise fail with an opaque
         *  transport error [sync.md]. Pure → unit-testable.
         *
         *  Must satisfy the shared case-set in `tests/conformance/server-url.json`
         *  (the source of truth for all three shells' copies of this rule);
         *  SyncManagerDefaultsTest mirrors those cases. */
        internal fun validateServerUrl(url: String): String? {
            val trimmed = url.trim()
            if (trimmed.isEmpty()) return "Enter a server URL."
            val lower = trimmed.lowercase()
            if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
                return "Add http:// or https:// to the start of the server URL."
            }
            return null
        }

        /** Live-loop auth errors and collection-gone are terminal for the old
         *  bearer session but recoverable with the securely stored password. */
        internal fun shouldHealLiveError(message: String): Boolean =
            message.startsWith("auth:") || message.contains("collection-gone")
    }
}

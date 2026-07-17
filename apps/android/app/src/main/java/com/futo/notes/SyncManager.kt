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
    var status by mutableStateOf("Not connected")
        private set
    var busy by mutableStateOf(false)
        private set
    var lastError by mutableStateOf<String?>(null)

    /** Whether the SSE live stream is currently connected. */
    var live by mutableStateOf(false)
        private set

    /** Invoked on the main thread after a sync that changed the vault on disk
     *  (downloaded/deleted > 0). The note list is a separate [NotesStore], so the
     *  Activity wires this to [NotesStore.reload] to surface pulled notes without
     *  a manual sync. Mirrors the iOS `SyncManager.onLivePull`. */
    var onLivePull: (() -> Unit)? = null

    private var client: SyncClient? = null

    /** Vault root of the current session, stashed at connect so an expired or
     *  collapsed session can be rebuilt without the Sync screen. */
    private var notesRoot: String? = null

    /** Guards against re-entrant heal attempts — collection-gone or auth expiry
     *  can surface from both the manual sync path and the live loop at once. */
    private var healing = false

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
                if (wroteLocalChanges(summary)) onLivePull?.invoke()
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
        // Be forgiving about whitespace, but catch the common mistake of a
        // schemeless URL up front with an actionable message instead of letting
        // it surface as a cryptic transport error [sync.md].
        val url = serverUrl.trim()
        validateServerUrl(url)?.let { error ->
            lastError = error
            status = "Error"
            return
        }
        busy = true; lastError = null; status = "Connecting…"
        this.notesRoot = notesRoot  // stash for a later session heal
        try {
            val c = SyncClient(notesRoot, url)
            val info = c.connect(password)
            client = c
            connected = true
            // Persist the session so the next launch reconnects silently
            // [sync.md:91]. Keystore + prefs I/O — off the main thread.
            withContext(Dispatchers.IO) {
                secure?.storePassword(password)
                prefs?.edit()?.putString(Prefs.SYNC_SERVER_URL, url)?.apply()
            }
            status = "Connected (${info.authMode}) · syncing…"
            val initial = c.syncNow()
            applyOutcome(initial)
            // Refresh the list/editor if the initial (catch-up) sync changed
            // the local tree — pulls OR push-side merges (F2).
            if (wroteLocalChanges(initial)) onLivePull?.invoke()
            c.startLive(LiveListener()) // onConnected flips `live` when the stream is up
        } catch (e: Exception) {
            connected = client != null
            lastError = describe(e)
            status = "Error"
        } finally {
            busy = false
        }
    }

    suspend fun syncNow() {
        val c = client ?: return
        busy = true; lastError = null; status = "Syncing…"
        try {
            applyOutcome(c.syncNow())
        } catch (e: Exception) {
            // Re-login for both a collapsed vault and an expired bearer token.
            // The same-vault path keeps the persisted cursor/object map, so
            // token expiry does not trigger a full reconcile.
            if (isRecoverableSessionError(e)) {
                healSession(describe(e))
            } else {
                lastError = describe(e); status = "Error"
            }
        } finally {
            busy = false
        }
    }

    /** Whether a sync error can be healed by logging in again with the password
     *  already stored in the Android Keystore. */
    private fun isRecoverableSessionError(e: Exception): Boolean =
        e is SyncException.Auth || e is SyncException.CollectionGone

    /** Heal an expired session or collapsed vault with the password stored at
     *  last connect. Auth expiry reuses the same collection's persisted state;
     *  collection-gone re-picks the survivor and safely reconciles. Missing
     *  recovery credentials surface the original error; guarded against
     *  re-entry. Mirrors iOS `healSession`. */
    private fun healSession(fallbackMessage: String) {
        if (healing) return
        val root = notesRoot
        if (root == null) {
            reportUnavailableSessionRecovery(fallbackMessage)
            return
        }
        healing = true
        client?.stopLive()
        scope.launch {
            val password = withContext(Dispatchers.IO) {
                runCatching { secure?.loadPassword() }.getOrNull()
            }
            if (password == null) {
                healing = false
                reportUnavailableSessionRecovery(fallbackMessage)
                return@launch
            }
            // The dead session's live loop stopped itself; connectAndSync builds
            // a fresh authenticated client + live loop without deleting state.
            connectAndSync(root, password)
            healing = false
        }
    }

    /** Route one live-loop failure through recovery or visible error state. */
    internal fun handleLiveError(message: String) {
        // Auth expiry and collection-gone are terminal for the old live loop,
        // but recoverable from the securely stored password.
        if (shouldHealLiveError(message)) {
            healSession(message)
        } else {
            lastError = message
        }
    }

    private fun reportUnavailableSessionRecovery(message: String) {
        lastError = message
        status = "Error"
    }

    /** Single reporter for a completed cycle's outcome [sync.md]: clean →
     *  "Sync complete" (no counts); per-item failures → the red error line,
     *  using `failureMessage` (computed once in the Rust core so every shell
     *  shows identical wording). Cleared by the next clean cycle. */
    internal fun applyOutcome(summary: SyncSummary) {
        val message = summary.failureMessage
        if (message != null) {
            lastError = message
            status = "Error"
        } else {
            status = "Sync complete"
            lastError = null
        }
    }

    /** Signal Rust that a local note changed so the live loop debounces and
     *  auto-pushes the edit to peers. Fire-and-forget and non-blocking on the
     *  Rust side — a no-op when not connected / no live task is running. The
     *  Activity wires this to every [NotesStore] mutation via
     *  [NotesStore.onLocalChange]. Mirrors the iOS `SyncManager.noteChanged`. */
    fun noteChanged() {
        client?.noteChanged()
    }

    /** Re-open the live stream after returning to the foreground (no-op if not
     *  connected or already live). Fire-and-forget from the Activity lifecycle. */
    fun resumeLiveAsync() {
        scope.launch {
            val c = client ?: return@launch
            if (!connected || live) return@launch
            try {
                c.startLive(LiveListener())
            } catch (e: Exception) {
                lastError = describe(e)
            }
        }
    }

    /** Tear down the live stream (e.g. app backgrounded). Keeps the session. */
    fun pauseLive() {
        client?.stopLive()
        live = false
    }

    /** Silent reconnect with the persisted session at startup [sync.md:91].
     *  Fire-and-forget, off-main — never gates render. Failures surface via
     *  [status]/[lastError] but do NOT wipe the stored password (the server
     *  may simply be unreachable); only [disconnect] clears it. */
    fun restoreSession(notesRoot: String) {
        scope.launch {
            if (connected) return@launch
            val password = withContext(Dispatchers.IO) {
                runCatching { secure?.loadPassword() }.getOrNull()
            } ?: return@launch
            connectAndSync(notesRoot, password)
        }
    }

    suspend fun disconnect() {
        try { client?.disconnect() } catch (_: Exception) {} // also stops live in Rust
        client = null
        connected = false
        live = false
        healing = false  // clear any stalled heal so a future session can heal
        status = "Not connected"
        lastError = null
        // Explicit disconnect is the ONLY place the stored password is wiped.
        withContext(Dispatchers.IO) { runCatching { secure?.clearPassword() } }
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
         *  must reload from disk? Peer downloads and deletes are obvious; the
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

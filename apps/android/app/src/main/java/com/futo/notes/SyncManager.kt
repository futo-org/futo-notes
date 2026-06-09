package com.futo.notes

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
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
 */
class SyncManager {
    var serverUrl by mutableStateOf("http://10.0.2.2:3005") // emulator → host loopback
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

    /** Marshals Rust live-sync callbacks onto the main thread. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private fun summarize(s: SyncSummary) =
        "Synced — ↑${s.uploaded} ↓${s.downloaded} ✕${s.deleted} ⚠${s.conflicts}"

    /** Receives live-sync events from Rust (on a tokio thread → hop to main). */
    private inner class LiveListener : SyncEventListener {
        override fun onSynced(summary: SyncSummary) {
            scope.launch {
                status = summarize(summary)
                lastError = null
                // A live pull wrote to disk — refresh the list (skip no-op pulls).
                if (summary.downloaded > 0u || summary.deleted > 0u) onLivePull?.invoke()
            }
        }
        override fun onConnected() {
            scope.launch { live = true }
        }
        override fun onError(message: String) {
            scope.launch { lastError = message }
        }
        override fun onStopped() {
            scope.launch { live = false }
        }
    }

    /** Connect (login + unwrap vault key), run an initial sync, then go live. */
    suspend fun connectAndSync(notesRoot: String, password: String) {
        busy = true; lastError = null; status = "Connecting…"
        try {
            val c = SyncClient(notesRoot, serverUrl)
            val info = c.connect(password)
            client = c
            connected = true
            status = "Connected (${info.authMode}) · syncing…"
            val initial = c.syncNow()
            status = summarize(initial)
            // Refresh the list if the initial (catch-up) sync pulled changes.
            if (initial.downloaded > 0u || initial.deleted > 0u) onLivePull?.invoke()
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
            status = summarize(c.syncNow())
        } catch (e: Exception) {
            lastError = describe(e); status = "Error"
        } finally {
            busy = false
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

    suspend fun disconnect() {
        try { client?.disconnect() } catch (_: Exception) {} // also stops live in Rust
        client = null
        connected = false
        live = false
        status = "Not connected"
        lastError = null
    }

    private fun describe(e: Exception): String = when (e) {
        is SyncException.Http -> "HTTP: ${e.message}"
        is SyncException.Crypto -> "Crypto: ${e.message}"
        is SyncException.Io -> "IO: ${e.message}"
        is SyncException.Auth -> "Auth: ${e.message}"
        is SyncException.NotConnected -> "Not connected"
        else -> e.message ?: e.toString()
    }
}

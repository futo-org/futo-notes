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
import uniffi.futo_notes_ffi.WriteRefusal

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
    internal val secure: SecureStore? = null,
    internal val prefs: SharedPreferences? = null,
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
        internal set
    var statusMessage by mutableStateOf(LocalizedMessage("sync.status.notConnected"))
        internal set
    var busy by mutableStateOf(false)
        internal set
    var lastErrorDiagnostic: String? = null
        internal set
    internal var errorMessage by mutableStateOf<LocalizedMessage?>(null)
        internal set

    /** Whether the LAST completed cycle's writes were refused, and which way
     *  (`futo_notes_sync::WriteRefusal`). Held here because this object
     *  outlives the sync screen, and the whole point is that a refusal arrives
     *  while the person is somewhere else; `HostedSyncSections` hands it to the
     *  hosted model, which turns it into a banner with an action. Never a latch
     *  — every completed cycle writes its own answer, null included. */
    var lastWriteRefusal by mutableStateOf<WriteRefusal?>(null)
        internal set

    fun localizedStatus(localization: Localization): String =
        localization.localizedText(statusMessage.path, statusMessage.arguments)

    fun localizedError(localization: Localization): String? = errorMessage?.let {
        localization.localizedText(it.path, it.arguments)
    }

    /** Whether the SSE live stream is currently connected. */
    var live by mutableStateOf(false)
        internal set

    /** Invoked on the main thread after a sync that changed the vault on disk.
     *  The complete summary lets [NotesStore] project only affected rows and
     *  lets the open editor render the engine's disposition. */
    var onLocalTreeChanged: ((SyncSummary) -> Unit)? = null

    internal var client: SyncClient? = null

    /** Vault root of the current session, stashed at connect so an expired or
     *  collapsed session can be rebuilt without the Sync screen. */
    internal var notesRoot: String? = null

    /** Guards against re-entrant heal attempts — collection-gone or auth expiry
     *  can surface from both the manual sync path and the live loop at once. */
    internal var healing = false

    /** Which door opened the session in [client], so [connectHosted] can tell
     *  the session it must not duplicate from the one it must replace. Set only
     *  where a session is adopted, cleared only where one is dropped.
     *  Mirrors iOS `SyncManager.sessionMode`. */
    internal var sessionMode: SessionMode? = null

    /** False from [pauseLive] (the app went to the background) until
     *  [resumeLiveAsync]. A live start checks it at the last moment, because
     *  the connect cycle or the gate wait before it can straddle a pause.
     *  Main thread only, like the lifecycle callbacks that set it. */
    internal var inForeground = true

    /** Drains connect/heal/manual/resume work before a vault migration starts
     * and rejects any new sync work until the old vault is resumed or the app
     * restarts on the migrated root. */
    internal val storageMigrationGate = StorageMigrationGate()

    /** Marshals Rust live-sync callbacks onto the main thread. */
    internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** Receives live-sync events from Rust (on a tokio thread → hop to main). */
    internal inner class LiveListener : SyncEventListener {
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

    // Visible for testing: the boolean-driven seed selection is pure (no
    // BuildConfig), so the SyncManagerDefaultsTest unit test can pin both
    // branches. `defaultServer()` wires in the real BuildConfig.DEBUG.
    /** Which door opened the session this manager is currently holding.
     *  Mirrors iOS `SyncManager.SessionMode`. */
    internal enum class SessionMode { SELF_HOSTED, HOSTED }

    /** What a hosted connect does about the session already in hand. */
    internal enum class HostedConnectEntry { SKIP, REPLACE_SELF_HOSTED, PROCEED }

    /** Which credential a cold launch reaches for. */
    internal enum class RestoreBranch { HOSTED, SELF_HOSTED, NOTHING }

    internal companion object {
        const val DEFAULT_SERVER = "http://10.0.2.2:3005" // emulator → host loopback (debug only)

        // ── Which session wins ───────────────────────────────────────────
        //
        // Both decisions are pure, so they are pinned by the shared cross-shell
        // case-set in tests/conformance/sync-session-mode.json rather than only
        // by whatever a device happened to do. Swift carries the same pair.

        /** What a hosted connect does about the session already in hand.
         *
         *  Mode-aware because it did not used to be: the guard skipped on *any*
         *  live session, and a self-hosted one is not a reason to skip the
         *  connect that is meant to replace it. Completing the wizard over a
         *  live password session left a normal-looking account card reading
         *  `0 B of 10 GB used` with no cycle behind it, and the next launch went
         *  back to the old server (iOS simulator, 2026-09-16). Justin's call the
         *  same day: finishing hosted setup replaces a self-hosted session.
         *  Mirrors iOS `SyncManager.hostedConnectEntry`. → sync.md */
        internal fun hostedConnectEntry(
            connected: Boolean,
            hasClient: Boolean,
            healing: Boolean,
            mode: SessionMode?,
        ): HostedConnectEntry {
            // A client that is gone cannot be holding a live loop, and a session
            // being healed is being rebuilt — neither is a session to skip for.
            if (connected && hasClient && !healing && mode == SessionMode.HOSTED) {
                return HostedConnectEntry.SKIP
            }
            // `hasClient` and not `connected`: a cycle that failed still leaves
            // the live loop running, and that loop is exactly what must not be
            // orphaned.
            if (hasClient && mode == SessionMode.SELF_HOSTED) {
                return HostedConnectEntry.REPLACE_SELF_HOSTED
            }
            return HostedConnectEntry.PROCEED
        }

        /** Which credential a cold launch reaches for. Both inputs are local
         *  secret-store reads, so this costs no network even on a launch with
         *  none.
         *
         *  **Holding both is a one-time migration heal that retires itself, not
         *  a change of precedence.** With no hosted vault the password still
         *  wins — that is what keeps a self-hosted device self-hosted, and it is
         *  the whole difference between this and the "just invert the
         *  precedence" option that was rejected for breaking the reverse case
         *  identically. Both shells stop offering the self-hosted fields once
         *  hosted sync is set up (`HostedSyncSections`, `screen != ACCOUNT`), so
         *  a device can no longer arrive at both secrets by any route a person
         *  can take; the only devices that hold both are ones stranded by a
         *  build from before a hosted connect cleared the password. Taking the
         *  hosted branch there runs that clear, after which the state cannot
         *  recur — so this branch stops being reachable on its own rather than
         *  needing a flag to switch it off. Do not "simplify" it into
         *  unconditional hosted-first. Justin's call, 2026-09-16.
         *  Mirrors iOS `SyncManager.restoreBranch`. → sync.md */
        internal fun restoreBranch(
            hasStoredPassword: Boolean,
            hasHostedVault: Boolean,
        ): RestoreBranch = when {
            hasHostedVault -> RestoreBranch.HOSTED
            hasStoredPassword -> RestoreBranch.SELF_HOSTED
            else -> RestoreBranch.NOTHING
        }

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

        internal fun needsPlatformTrust(url: String): Boolean =
            url.trim().lowercase().startsWith("https://")

        /** Live-loop auth errors and collection-gone are terminal for the old
         *  bearer session but recoverable with the securely stored password. */
        internal fun shouldHealLiveError(message: String): Boolean =
            message.startsWith("auth:") || message.contains("collection-gone")

        /** The short form of a refused write, for the row that shows sync
         *  status at a glance. Mirrors iOS `writeRefusalHeadline`. */
        internal fun writeRefusalHeadline(refusal: WriteRefusal): String =
            when (refusal) {
                WriteRefusal.SUBSCRIPTION_REQUIRED -> "sync.hosted.banner.syncPaused.title"
                WriteRefusal.QUOTA_EXCEEDED -> "sync.hosted.banner.vaultFull.title"
            }

        /** The whole sentence, including what still works. All three shells
         *  read the same catalog entries, so a paused sync reads the same on
         *  every platform. Mirrors iOS `writeRefusalExplanation`. */
        internal fun writeRefusalExplanation(refusal: WriteRefusal): String =
            when (refusal) {
                WriteRefusal.SUBSCRIPTION_REQUIRED -> "sync.errors.writePausedSubscription"
                WriteRefusal.QUOTA_EXCEEDED -> "sync.errors.writePausedQuota"
            }
    }
}

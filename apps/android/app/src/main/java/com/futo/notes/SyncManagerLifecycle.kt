package com.futo.notes

import com.futo.notes.localization.LocalizedMessage
import com.futo.notes.SyncManager.Companion.restoreBranch
import com.futo.notes.SyncManager.RestoreBranch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.futo_notes_ffi.SyncException

/** Signal Rust that a local note changed so the live loop debounces and
 *  auto-pushes the edit to peers. Fire-and-forget and non-blocking on the
 *  Rust side — a no-op when not connected / no live task is running. The
 *  Activity wires this to every [NotesStore] mutation via
 *  [NotesStore.onLocalChange]. Mirrors the iOS `SyncManager.noteChanged`. */
fun SyncManager.noteChanged() {
    if (!storageMigrationGate.isMigrationStarted) client?.noteChanged()
}

/** Re-open the live stream after returning to the foreground (no-op if not
 *  connected or already live). Fire-and-forget from the Activity lifecycle. */
fun SyncManager.resumeLiveAsync() {
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
fun SyncManager.pauseLive() {
    // Storage migration owns a graceful stop. An onStop callback landing
    // between the synchronous latch and quiescence must not abort that task.
    if (storageMigrationGate.isMigrationStarted) return
    client?.stopLive()
    live = false
}

/** Synchronously reject new sync work before migration starts. The later
 * suspend step drains work and performs a graceful stop. */
fun SyncManager.beginStorageMigration() {
    storageMigrationGate.beginMigration()
}

/** Stop live sync and wait for any connect/manual cycle already in flight. */
suspend fun SyncManager.quiesceForStorageMigration() {
    storageMigrationGate.runMigration {
        client?.stopLiveAndWait()
        live = false
    }
}

/** Re-enable the old session when vault migration or preference commit fails. */
fun SyncManager.resumeAfterStorageMigrationFailure() {
    storageMigrationGate.resume()
    resumeLiveAsync()
}

/** Silent reconnect with the persisted session at startup [sync.md:91].
 *  Fire-and-forget, off-main — never gates render (M1). Failures surface via
 *  [statusMessage]/[lastErrorDiagnostic] but do NOT wipe what is stored (the
 *  server may simply be unreachable); a hosted connect and an explicit
 *  [disconnect] are what clear the password, and only an explicit sign out
 *  clears the hosted secrets.
 *
 *  A self-hosted vault is the one with a password to reconnect with; a
 *  hosted vault has none and is recognized instead by the two secrets Rust
 *  saved. Both are local reads — no request of any kind — so a launch with
 *  no network still knows which kind of vault this is, and a restart
 *  resumes sync **without Settings ever being opened**.
 *
 *  [restoreBranch] owns the choice, including the one device that answers
 *  to both; read its doc before changing the order here. → sync.md */
fun SyncManager.restoreSession(notesRoot: String) {
    scope.launch {
        storageMigrationGate.runAccessIfAvailable {
            if (connected) return@runAccessIfAvailable
            val password = withContext(Dispatchers.IO) {
                runCatching { secure?.loadPassword() }.getOrNull()
            }
            val setup = makeHostedSetup(notesRoot)
            val hasHostedVault = setup != null && hasSavedVault(setup)
            when (restoreBranch(password != null, hasHostedVault)) {
                RestoreBranch.HOSTED ->
                    connectHostedLocked(notesRoot, setup ?: return@runAccessIfAvailable)
                RestoreBranch.SELF_HOSTED ->
                    connectAndSyncLocked(notesRoot, password ?: return@runAccessIfAvailable)
                RestoreBranch.NOTHING -> return@runAccessIfAvailable
            }
        }
    }
}

suspend fun SyncManager.disconnectForReset() {
    storageMigrationGate.beginMigration()
    storageMigrationGate.runMigration {
        client?.stopLiveAndWait()
        disconnect()
    }
}

fun SyncManager.finishReset() { storageMigrationGate.resume() }

suspend fun SyncManager.disconnect() {
    tearDownSession()
    // An explicit disconnect is where the USER wipes the stored password;
    // the other place it goes is Rust's `connect_sync` when a hosted
    // session starts (docs/spec/sync.md, "Exactly one sync credential").
    withContext(Dispatchers.IO) { runCatching { secure?.clearPassword() } }
}

/** Ends the session this manager is holding, for real: Rust stops the live
 *  loop and demotes this vault's sync state, and nothing local is left
 *  pointing at a client that is gone. Touches no stored secret — the
 *  explicit [disconnect] adds the password clear, and the hosted switch
 *  leaves it to Rust's `connect_sync`. Mirrors iOS `tearDownSession`. */
internal suspend fun SyncManager.tearDownSession() {
    try { client?.disconnect() } catch (_: Exception) {} // also stops live in Rust
    forgetSession()
}

/** Drops this manager's view of a session, without touching disk or any
 *  secret — what is left to do once Rust has revoked and demoted one. */
internal fun SyncManager.forgetSession() {
    client = null
    sessionMode = null
    connected = false
    live = false
    healing = false  // clear any stalled heal so a future session can heal
    lastErrorDiagnostic = null
    statusMessage = LocalizedMessage("sync.status.notConnected")
    errorMessage = null
}

internal fun SyncManager.describe(e: Exception): String = when (e) {
    is SyncException.Http -> "HTTP: ${e.v1}"
    is SyncException.Crypto -> "Crypto: ${e.v1}"
    is SyncException.Io -> "IO: ${e.v1}"
    is SyncException.Auth -> "Auth: ${e.v1}"
    is SyncException.CollectionGone -> e.v1
    is SyncException.NotConnected -> "Not connected"
    else -> e.message ?: e.toString()
}

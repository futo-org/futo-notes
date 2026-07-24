package com.futo.notes

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.futo.notes.storage.NotesStorage
import com.futo.notes.storage.StorageMigrationGate
import uniffi.futo_notes_ffi.FlushDisposition
import uniffi.futo_notes_ffi.NoteMutation
import uniffi.futo_notes_ffi.NoteStore
import uniffi.futo_notes_ffi.NoteMetadata
import uniffi.futo_notes_ffi.SearchHit
import uniffi.futo_notes_ffi.VaultMigrationStatus
import uniffi.futo_notes_ffi.VaultMigrationFinalization
import java.io.File

/** A single note for the UI. Mirrors the iOS `NoteItem`; `tags` are canonical
 *  lowercase names WITHOUT the leading `#`. */
data class NoteItem(
    val id: String,
    val title: String,
    val folder: String,
    val modifiedMs: Long,
    /** Single-line preview (search filtering). */
    val preview: String,
    /** Multi-line, display-oriented preview: block markdown rewritten for
     *  rendering (☐/☑ task glyphs, • bullets, tables dropped, inline emphasis
     *  kept, line breaks preserved). Rendered as an AnnotatedString in the list.
     *  See `make_rich_preview` in futo-notes-model. */
    val richPreview: String,
    val tags: List<String>,
)

/** Budget handed to the engine's bounded search-readiness wait
 *  (`NoteStore.waitUntilSearchReady`) — the 200×25ms this shell's former poll
 *  loop allowed. */
internal const val SEARCH_READY_TIMEOUT_MS: ULong = 5_000uL

/** An open editor's unsaved draft: the note [id] to persist, the [content] to
 *  write, and [base] — the content the editor believes is on disk (its
 *  savedContent). [base] is the expected-previous for the conditional flush
 *  (see [NotesStore.flushAsync] → `write_if_unchanged`): the flush writes only
 *  if the note still holds [base], so a note deleted or sync-adopted while
 *  backgrounded is neither resurrected nor clobbered. Mirrors the iOS
 *  `pendingDraft` tuple. */
data class PendingDraft(val id: String, val base: String, val content: String)

sealed interface NoteMutationOutcome<out T> {
    data class Committed<T>(val value: T) : NoteMutationOutcome<T>
    data object Failed : NoteMutationOutcome<Nothing>
}

internal fun confirmedSavedContent(
    previousSavedContent: String,
    writtenContent: String,
    outcome: NoteMutationOutcome<Unit>,
): String = when (outcome) {
    is NoteMutationOutcome.Committed -> writtenContent
    NoteMutationOutcome.Failed -> previousSavedContent
}

internal fun shouldCompleteNoteAction(outcome: NoteMutationOutcome<*>): Boolean =
    outcome is NoteMutationOutcome.Committed

internal fun shouldContinueDeleteAfterEditorWrite(
    hasPendingChanges: Boolean,
    outcome: NoteMutationOutcome<Unit>?,
): Boolean = !hasPendingChanges || outcome is NoteMutationOutcome.Committed

internal suspend fun <T> runMutationTransaction(
    transaction: suspend () -> T,
): T {
    currentCoroutineContext().ensureActive()
    return withContext(NonCancellable) {
        transaction()
    }
}

/** The open editor's unsaved-draft derivation — the ONE definition of "is there
 *  an unsaved draft, for which note" (PKT-12 R5). Returns a draft keyed on the
 *  LIVE [noteId] (so it re-keys by construction after a rename) whenever the body
 *  has loaded and diverges from what's on disk; null when clean or not yet
 *  loaded. [savedContent] is both the dirty check and the flush's expected-prev
 *  [base]. Pulled synchronously at flush time by [PendingEditorDraft]. Pure +
 *  top-level so it is unit-testable without composition. */
internal fun derivePendingDraft(
    loaded: Boolean,
    noteId: String,
    savedContent: String,
    content: String,
): PendingDraft? =
    if (loaded && content != savedContent) PendingDraft(noteId, savedContent, content) else null

internal enum class AdoptFlushOutcome { KEEP_DRAFT, RELOAD_DISK, RETRY_LATER }

internal fun adoptFlushOutcome(disposition: FlushDisposition?): AdoptFlushOutcome =
    when (disposition) {
        FlushDisposition.Wrote,
        FlushDisposition.Converged,
        FlushDisposition.Recreated,
        -> AdoptFlushOutcome.KEEP_DRAFT
        is FlushDisposition.ParkedConflict -> AdoptFlushOutcome.RELOAD_DISK
        null -> AdoptFlushOutcome.RETRY_LATER
    }

/**
 * The open editor's unsaved-draft register and its leave-foreground flush,
 * factored out of [NotesStore]/Compose so the F8 jetsam-guard decision is
 * unit-testable — apps/android ships JUnit only (no Robolectric/coroutines-test),
 * so the FFI-backed [NotesStore] can't be constructed in a JVM test.
 *
 * The register is DERIVED and PULL-based: each open editor registers ONE
 * derivation closure (`{ if (loaded && content != savedContent) draft else null }`)
 * via [setProvider]; [flush] invokes them SYNCHRONOUSLY at the leave-foreground
 * edge to read each editor's live state (PKT-12 R5). One source of truth instead
 * of ~7 imperative set/clear sites that raced the editor (PKT-1 R1-R4). Pulling
 * at flush time (rather than an async snapshotFlow that pushes updates) closes
 * the publication-window gap: an edit landing immediately before onPause is
 * always seen, because the provider reads the current snapshot state when the
 * flush runs, not whenever a conflated async collector last happened to fire.
 *
 * The register is a MAP of generation-token → provider, NOT a single slot. During
 * the AnimatedContent cross-fade the incoming editor composes (and registers its
 * provider) before the outgoing one disposes, so both are briefly live. A single
 * slot would let the incoming editor's registration EVICT the outgoing (still
 * dirty) editor's provider — and since the incoming editor is unloaded it derives
 * null, so a pause+kill before the outgoing's dispose would flush nothing and
 * lose its edit (PKT-1 R2 / PKT-12 G1). Keeping every live provider and flushing
 * ALL of them (at most two during a cross-fade) kills that eviction by
 * construction; [release] removes only the caller's own entry.
 *
 * MainActivity.onPause calls [flush] at the FIRST leave-foreground signal.
 * Idempotent, and a no-op when every open editor is clean / closed. Mirrors iOS
 * `NotesStore.pendingDraft` + `flushPendingEditor` [editor.md].
 */
internal class PendingEditorDraft(private val persist: (draft: PendingDraft) -> Unit) {
    private var seq: Long = 0
    private val providers = LinkedHashMap<Long, () -> PendingDraft?>()
    private val retained = LinkedHashMap<Long, PendingDraft>()

    /** A newly-composed editor claims an entry; returns its unique generation
     *  token (the map key). Registration/removal are keyed by it, so editors
     *  overlapping during a cross-fade never touch each other's entry. */
    fun claim(): Long = ++seq

    /** The editor registers (or re-registers) its derivation closure under its
     *  own [token]. Never evicts another editor's entry. */
    fun setProvider(token: Long, provider: () -> PendingDraft?) {
        providers[token] = provider
    }

    /** The editor left composition. Keep its last dirty value until a storage
     *  operation proves that exact draft durable. */
    fun release(token: Long) {
        providers.remove(token)?.invoke()?.let { retained[token] = it }
    }

    fun complete(draft: PendingDraft) {
        retained.entries.removeAll { it.value == draft }
    }

    /** Snapshot retained drafts present when an ordinary save starts. */
    fun retainedSnapshot(id: String): Map<Long, PendingDraft> =
        retained.filterValues { it.id == id }

    /** Clear only snapshots that are still the admitted values. */
    fun completeSnapshot(snapshot: Map<Long, PendingDraft>) {
        snapshot.forEach { (token, draft) ->
            if (retained[token] == draft) retained.remove(token)
        }
    }

    fun discardNote(id: String) {
        retained.entries.removeAll { it.value.id == id }
        providers.entries.removeAll { it.value()?.id == id }
    }

    fun retargetRetainedNote(oldId: String, finalId: String) {
        retained.replaceAll { _, draft ->
            if (draft.id == oldId) draft.copy(id = finalId) else draft
        }
    }

    /** Persist every live editor's current draft by pulling each provider
     *  SYNCHRONOUSLY (so the newest keystroke is always seen). Flushes all live
     *  providers — at most two during a cross-fade — so an outgoing dirty editor
     *  is never dropped. No-op when every provider derives clean / closed; safe to
     *  call at every leave-foreground signal.
     *
     *  Derivations are COALESCED by note id before dispatching, so two editors
     *  overlapping on the SAME note during a cross-fade (e.g. rename + self-link
     *  navigation, both dirty) never fire two conditional writes that read the
     *  same base and race — exactly one flush per note. The winner is the
     *  LAST-registered provider's draft (LinkedHashMap insertion order): the
     *  incoming editor is the user's current view, so its content wins. */
    fun flush() {
        currentDrafts().forEach { persist(it) }
    }

    /** Snapshot and coalesce the live drafts for an exclusive vault operation. */
    fun currentDrafts(): List<PendingDraft> {
        val byId = LinkedHashMap<String, PendingDraft>()
        retained.values.forEach { byId[it.id] = it }
        providers.values.toList().forEach { provider -> provider()?.let { byId[it.id] = it } }
        return byId.values.toList()
    }
}

/**
 * Reactive shell around the Rust note domain (`NoteStore`, UniFFI) — the exact
 * counterpart of the iOS `NotesStore.swift`. ALL business logic (filename/tag
 * rules, scan/preview, CRUD, folder ops) lives in `futo-notes-model` and is
 * reached through `core`; this class only holds Compose state and seeds.
 */
class NotesStore(notesRoot: File, searchIndex: File) {
    var notes by mutableStateOf<List<NoteItem>>(emptyList())
        private set
    var folders by mutableStateOf<List<String>>(emptyList())
        private set

    val rootPath: String = notesRoot.absolutePath

    /** Invoked after every local mutation (write/create/delete/rename/move/
     *  createFolder) that touches the vault on disk. The Activity wires this to
     *  [SyncManager.noteChanged] so a connected live session debounces and
     *  auto-pushes the edit to peers. Mirrors the iOS `NotesStore.onLocalChange`. */
    var onLocalChange: (() -> Unit)? = null

    /** When true, mutations do NOT signal [onLocalChange] — set by the full-
     *  reset flow so the bulk wipe can't trigger an auto-push mid-delete
     *  [settings.md:43]. Mirrors desktop `resetAllNotes` pausing auto-sync. */
    var suppressAutoPush = false

    /** The Rust-owned vault — the single source of truth for the rules.
     *
     *  LAZY ON PURPOSE: the Rust ctor does no I/O, but the *first* FFI touch
     *  triggers JNA's one-time `libfuto_notes_ffi.so` load (a disk read). Making
     *  `core` lazy defers that load to the first access — and every access is
     *  inside `withContext(Dispatchers.IO)`, so the native-lib load lands off the
     *  main thread instead of in the field initializer during `onCreate`. Mirrors
     *  the iOS `NoteVault` actor (the handle only ever lives off-main). */
    private val core: NoteStore by lazy { NoteStore(rootPath) }

    /** Serializes every vault-root access, including image writes, with migration. */
    private val storageMigrationGate = StorageMigrationGate()
    val isVaultMigrationStarted: Boolean
        get() = storageMigrationGate.isMigrationStarted

    /** Owns the background scan + every FFI mutation. State writes hop back to
     *  [Dispatchers.Main.immediate] (this scope's dispatcher) so Compose state is
     *  only ever touched on the main thread — same discipline as [SyncManager]. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    init {
        // Bootstrap, migrations, seeding, and search startup are one Rust call,
        // kept off-main so first render never waits for disk I/O.
        scope.launch {
            val bootstrap = withCore {
                core.bootstrap(searchIndex.absolutePath)
            }
            applySnapshot(bootstrap.snapshot.notes, bootstrap.snapshot.folders)
            bootstrap.warnings.forEach {
                android.util.Log.w("NotesStore", "local-note bootstrap: $it")
            }
            if (BuildConfig.DEBUG) {
                android.util.Log.i("FutoStartup", "initial scan complete: ${notes.size} notes")
            }
        }
    }

    /** Fire-and-forget rescan for non-coroutine callers (e.g. the [SyncManager]
     *  live-pull callback, which is a plain lambda). Launches on the store's
     *  main-immediate scope; the scan itself still runs on IO inside [reload]. */
    fun reloadAsync() {
        scope.launch { reload() }
    }

    /** Rescan the vault off the main thread, then publish on the main thread. */
    suspend fun reload() {
        val snapshot = withCore { core.scan() }
        applySnapshot(snapshot.notes, snapshot.folders)
    }

    suspend fun read(id: String): String = withCore { core.read(id) }
    suspend fun exists(id: String): Boolean = withCore { core.exists(id) }

    /** Save an editor image and consume its filename while holding the same
     * migration gate as note workflows. The consumer is part of the operation:
     * image insertion reaches the WebView before migration may snapshot it. */
    suspend fun saveImageIntoVault(
        save: (File) -> String?,
        useSavedImage: suspend (String) -> Unit,
    ): String? =
        try {
            withVaultAccess {
                val filename = save(File(rootPath))
                if (filename != null) useSavedImage(filename)
                filename
            }
        } catch (e: Exception) {
            android.util.Log.e("NotesStore", "image save failed", e)
            null
        }

    /** Fire-and-forget flush for the editor's leave paths (`onDispose` on pop,
     *  and the register's onPause flush): a composable's dispose callback can't
     *  suspend, so the final save runs on the store's scope (which outlives the
     *  screen).
     *
     *  Rust's one `flush_draft` workflow writes, converges, recreates, or parks
     *  the draft under the store's mutation gate. */
    fun flushAsync(draft: PendingDraft) {
        val admission = editorDraftCoordinator.admit(draft.id) ?: return
        val previous = editorDraftTail
        editorDraftTail = scope.launch {
            previous?.join()
            if (!editorDraftCoordinator.permits(admission)) return@launch
            if (flushDraftDirect(draft) != null) pendingEditor.complete(draft)
        }
    }

    /** Persist-or-park one exact editor snapshot through the Rust workflow. */
    suspend fun flushDraft(draft: PendingDraft): FlushDisposition? =
        flushDraftDirect(draft)

    private suspend fun flushDraftDirect(draft: PendingDraft): FlushDisposition? = try {
        runMutationTransaction {
            val result = withCore { core.flushDraft(draft.id, draft.base, draft.content) }
            result.mutation?.let {
                applyMutation(it)
                signalLocalChange()
            }
            result.disposition
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "flush failed for ${draft.id}", e)
        null
    }

    /** The open editors' unsaved-draft register (F8 jetsam guard). Each editor
     *  registers ONE derivation closure via [setDraftProvider] under its own
     *  token; the Activity's onPause calls [flushPendingEditor], which pulls every
     *  live closure synchronously so an edit caught inside the 400 ms autosave
     *  debounce — even one landing right before onPause, and even in an editor
     *  still overlapping during a nav cross-fade — is persisted before the OS can
     *  kill the backgrounded process. Mirrors iOS `NotesStore.pendingDraft`. */
    private val pendingEditor = PendingEditorDraft { draft -> flushAsync(draft) }
    private val editorDraftCoordinator = EditorDraftCoordinator()
    private var editorDraftTail: Job? = null

    /** A newly-composed editor claims a register entry; returns its unique token.
     *  Entries are keyed by it, so editors overlapping during the AnimatedContent
     *  cross-fade never evict each other's provider (PKT-1 R2 / PKT-12 G1). */
    fun claimDraftOwnership(): Long = pendingEditor.claim()

    /** The editor registers its derivation closure under its [token] — evaluated
     *  synchronously at flush time (onPause). Replaces the old hand-synced
     *  set/clear sites: the register reflects the editor's live state on demand. */
    fun setDraftProvider(token: Long, provider: () -> PendingDraft?) =
        pendingEditor.setProvider(token, provider)

    /** The editor left composition. Its dirty value remains retained until the
     *  asynchronous flush proves it durable. */
    fun releaseDraftOwnership(token: Long) = pendingEditor.release(token)

    /** Flush the open editor's pending draft to disk if it has unsaved edits.
     *  Called from MainActivity.onPause (the first leave-foreground signal).
     *  Fire-and-forget via [flushAsync], which uses persist-or-park semantics.
     *  Mirrors iOS `flushPendingEditor`.
     *  Best-effort: the write is fire-and-forget, so an immediate process death
     *  can still beat it (same on iOS). */
    fun flushPendingEditor() = pendingEditor.flush()

    /** Freeze store access before the WebView's final synchronous snapshot.
     * Refuse while a write is active: image saves complete with a later editor
     * callback, so merely waiting for their file I/O would snapshot too early. */
    fun tryBeginStorageMigration(): Boolean =
        storageMigrationGate.tryBeginMigrationWhenIdle()

    /**
     * Flush live editor drafts and hold the vault gate across migration. Existing
     * store operations finish before the copy starts; the Activity blocks new UI
     * input and pauses sync before calling this method.
     */
    suspend fun migrateVault(to: File): NotesStorage.MigrationOutcome {
        val drafts = pendingEditor.currentDrafts()
        val mutations = mutableListOf<NoteMutation>()
        val outcome = withContext(Dispatchers.IO) {
            storageMigrationGate.runMigration {
                val flushFailed = drafts.any { draft ->
                    try {
                        val result = core.flushDraft(draft.id, draft.base, draft.content)
                        result.mutation?.let(mutations::add)
                        false
                    } catch (e: Exception) {
                        android.util.Log.e(
                            "NotesStore",
                            "migration draft flush failed for ${draft.id}",
                            e,
                        )
                        true
                    }
                }
                if (flushFailed) {
                    NotesStorage.MigrationOutcome.Failed(
                        "An open editor change could not be saved. The storage mode was not changed.",
                    )
                } else {
                    val staged = core.stageVaultMigration(to.absolutePath)
                    when (staged.status) {
                        VaultMigrationStatus.MIGRATED ->
                            NotesStorage.MigrationOutcome.Migrated(staged.files.toInt())
                        VaultMigrationStatus.EMPTY_SOURCE ->
                            NotesStorage.MigrationOutcome.EmptySource
                        VaultMigrationStatus.ALREADY_AT_DESTINATION ->
                            NotesStorage.MigrationOutcome.AlreadyAtDestination
                    }
                }
            }
        }
        mutations.forEach(::applyMutation)
        return outcome
    }

    /** Re-open the old root after a migration or preference-commit failure. */
    fun resumeAfterStorageMigrationFailure() {
        storageMigrationGate.resume()
    }

    suspend fun finalizeVaultMigration(
        to: File,
        allowSourceRemoval: Boolean,
    ): VaultMigrationFinalization =
        withContext(Dispatchers.IO) {
            storageMigrationGate.runMigration {
                core.finalizeVaultMigration(to.absolutePath, allowSourceRemoval)
            }
        }

    /** Write one note and consume the complete committed mutation. */
    suspend fun write(id: String, content: String): NoteMutationOutcome<Unit> =
        try {
            runMutationTransaction {
                val retainedAtAdmission = pendingEditor.retainedSnapshot(id)
                val mutation = withCore { core.write(id, content) }
                applyMutation(mutation)
                pendingEditor.completeSnapshot(retainedAtAdmission)
                signalLocalChange()
                NoteMutationOutcome.Committed(Unit)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            android.util.Log.e("NotesStore", "write failed for $id", e)
            NoteMutationOutcome.Failed
        }

    suspend fun createNote(title: String, folder: String = ""): String? =
        try {
            runMutationTransaction {
                val mutation = withCore { core.createNote(title, folder, "") }
                applyMutation(mutation)
                val createdId = mutation.finalId ?: title
                editorDraftCoordinator.reopen(createdId)
                signalLocalChange()
                createdId
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            android.util.Log.e("NotesStore", "createNote failed", e)
            null
        }

    suspend fun delete(id: String): NoteMutationOutcome<Unit> {
        currentCoroutineContext().ensureActive()
        val identity = editorDraftCoordinator.beginIdentityMutation(id)
        val pendingFlushes = editorDraftTail
        return try {
            pendingFlushes?.join()
            runMutationTransaction {
                val mutation = withCore { core.delete(id) }
                applyMutation(mutation)
                pendingEditor.discardNote(id)
                editorDraftCoordinator.finishIdentityMutation(identity, committed = true)
                signalLocalChange()
                NoteMutationOutcome.Committed(Unit)
            }
        } catch (e: CancellationException) {
            editorDraftCoordinator.finishIdentityMutation(identity, committed = false)
            throw e
        } catch (e: Exception) {
            editorDraftCoordinator.finishIdentityMutation(identity, committed = false)
            android.util.Log.e("NotesStore", "delete failed", e)
            NoteMutationOutcome.Failed
        }
    }

    /** Fire-and-forget delete for the editor's `onDispose` (can't suspend; the
     *  composable's scope is already gone). Runs on the store's scope, which
     *  outlives the screen — used to discard an untouched quick-capture note on
     *  back-out (NoteEditorScreen.kt onDispose). Mirrors [flushAsync]. */
    fun deleteAsync(id: String) {
        scope.launch { delete(id) }
    }

    suspend fun rename(oldId: String, newId: String): NoteMutationOutcome<String> {
        currentCoroutineContext().ensureActive()
        val identity = editorDraftCoordinator.beginIdentityMutation(oldId)
        val pendingFlushes = editorDraftTail
        return try {
            pendingFlushes?.join()
            runMutationTransaction {
                val mutation = withCore { core.rename(oldId, newId) }
                val finalId = mutation.finalId ?: oldId
                applyMutation(mutation)
                pendingEditor.retargetRetainedNote(oldId, finalId)
                editorDraftCoordinator.finishIdentityMutation(identity, committed = true)
                editorDraftCoordinator.reopen(finalId)
                signalLocalChange()
                NoteMutationOutcome.Committed(finalId)
            }
        } catch (e: CancellationException) {
            editorDraftCoordinator.finishIdentityMutation(identity, committed = false)
            throw e
        } catch (e: Exception) {
            editorDraftCoordinator.finishIdentityMutation(identity, committed = false)
            android.util.Log.e("NotesStore", "rename failed", e)
            NoteMutationOutcome.Failed
        }
    }

    suspend fun moveNote(
        id: String,
        toFolder: String,
        createFolder: Boolean = false,
    ): NoteMutationOutcome<String> {
        currentCoroutineContext().ensureActive()
        val identity = editorDraftCoordinator.beginIdentityMutation(id)
        val pendingFlushes = editorDraftTail
        return try {
            pendingFlushes?.join()
            runMutationTransaction {
                val mutation = withCore {
                    if (createFolder) {
                        core.moveNoteToNewFolder(id, toFolder)
                    } else {
                        core.moveNote(id, toFolder)
                    }
                }
                val finalId = mutation.finalId ?: id
                applyMutation(mutation)
                pendingEditor.retargetRetainedNote(id, finalId)
                editorDraftCoordinator.finishIdentityMutation(identity, committed = true)
                editorDraftCoordinator.reopen(finalId)
                signalLocalChange()
                NoteMutationOutcome.Committed(finalId)
            }
        } catch (e: CancellationException) {
            editorDraftCoordinator.finishIdentityMutation(identity, committed = false)
            throw e
        } catch (e: Exception) {
            editorDraftCoordinator.finishIdentityMutation(identity, committed = false)
            android.util.Log.e("NotesStore", "moveNote failed", e)
            NoteMutationOutcome.Failed
        }
    }

    suspend fun createFolder(path: String): NoteMutationOutcome<Unit> =
        try {
            runMutationTransaction {
                val mutation = withCore { core.createFolder(path) }
                applyMutation(mutation)
                signalLocalChange()
                NoteMutationOutcome.Committed(Unit)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            android.util.Log.e("NotesStore", "createFolder failed", e)
            NoteMutationOutcome.Failed
        }

    suspend fun renameFolder(from: String, to: String): String? =
        try {
            runMutationTransaction {
                val mutation = withCore { core.renameFolder(from, to) }
                applyMutation(mutation)
                signalLocalChange()
                mutation.finalFolder ?: to
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            android.util.Log.e("NotesStore", "renameFolder failed $from -> $to", e)
            null
        }

    suspend fun moveFolder(from: String, destinationParent: String): String? =
        try {
            runMutationTransaction {
                val mutation = withCore { core.moveFolder(from, destinationParent) }
                applyMutation(mutation)
                signalLocalChange()
                mutation.finalFolder ?: from
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            android.util.Log.e(
                "NotesStore",
                "moveFolder failed $from -> $destinationParent",
                e,
            )
            null
        }

    /** MOVE-UP folder delete (Tauri parity, [list.md:121]): notes under
     *  [path] move to the parent (Rust bails atomically — if ANY move fails
     *  nothing is deleted), wikilinks are relinked, then the folder tree goes.
     *  Returns the moved-note count, or null when the FFI rejected the delete
     *  (the folder is left intact). */
    suspend fun deleteFolder(path: String): UInt? =
        try {
            runMutationTransaction {
                val mutation = withCore { core.deleteFolder(path) }
                applyMutation(mutation)
                signalLocalChange()
                mutation.removed.size.toUInt()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            android.util.Log.e("NotesStore", "deleteFolder failed for $path", e)
            null
        }

    /** Full reset [settings.md:43]: delete every note, folder, and `.crashlogs`
     *  under the vault root. Parity model: desktop `resetAllNotes`
     *  (src/app/resetAllNotes.ts). Callers pause sync + set [suppressAutoPush]
     *  for the duration and disconnect sync afterwards. */
    suspend fun deleteAll() {
        withCore { core.reset() }
        notes = emptyList()
        folders = emptyList()
    }

    /** A live pull bypassed local mutations. Reconcile the same store-owned
     *  index, then project one fresh durable snapshot. */
    fun liveDataChanged() {
        scope.launch {
            withCore { core.rescan() }
            reload()
        }
    }

    /** The engine owns the bounded readiness wait; a timeout returns an empty
     *  result while the self-healing index continues in the background. */
    suspend fun search(query: String, limit: UInt = 50u): List<SearchHit> =
        withContext(Dispatchers.IO) {
            if (core.waitUntilSearchReady(SEARCH_READY_TIMEOUT_MS)) {
                core.search(query, limit)
            } else {
                emptyList()
            }
        }

    private fun signalLocalChange() {
        if (!suppressAutoPush) onLocalChange?.invoke()
    }

    private suspend fun <T> withVaultAccess(block: suspend () -> T): T =
        withContext(Dispatchers.IO) {
            storageMigrationGate.runAccess { block() }
        }

    private suspend fun <T> withCore(block: () -> T): T = withVaultAccess(block)

    /** Immediate child folders of `folder` ("" = root). */
    fun subfolders(of: String): List<String> {
        val prefix = if (of.isEmpty()) "" else "$of/"
        return folders.filter { path ->
            path.startsWith(prefix) && path.drop(prefix.length).let { it.isNotEmpty() && !it.contains('/') }
        }
    }

    /** Notes whose parent folder is exactly `folder`. */
    fun notesIn(folder: String): List<NoteItem> = notes.filter { it.folder == folder }

    private fun applySnapshot(metadata: List<NoteMetadata>, folderPaths: List<String>) {
        notes = metadata.map { it.toItem() }
        folders = folderPaths
    }

    /** Positions are post-removal; clamp them against a stale shell cache. */
    private fun applyMutation(mutation: NoteMutation) {
        val affected = mutation.removed.toSet() + mutation.upserted.map { it.note.id }
        val next = notes.filterNot { it.id in affected }.toMutableList()
        mutation.upserted.forEach { entry ->
            val position = entry.position.toInt().coerceIn(0, next.size)
            next.add(position, entry.note.toItem())
        }
        notes = next
        folders = mutation.folders
        mutation.warnings.forEach {
            android.util.Log.w("NotesStore", "local-note mutation: $it")
        }
    }

    private fun NoteMetadata.toItem() =
        NoteItem(id, title, folder, modifiedMs, preview, richPreview, tags)
}

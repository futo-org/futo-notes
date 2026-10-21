package com.futo.notes

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.futo.notes.storage.NotesStorage
import com.futo.notes.storage.StorageDestination
import com.futo.notes.storage.StorageMigrationGate
import uniffi.futo_notes_ffi.FlushDisposition
import uniffi.futo_notes_ffi.NoteMutation
import uniffi.futo_notes_ffi.NoteSortOrder
import uniffi.futo_notes_ffi.NoteStore
import uniffi.futo_notes_ffi.NoteMetadata
import uniffi.futo_notes_ffi.SearchHit
import uniffi.futo_notes_ffi.SyncSummary
import uniffi.futo_notes_ffi.VaultDestinationState
import uniffi.futo_notes_ffi.VaultMigrationStatus
import uniffi.futo_notes_ffi.VaultMigrationFinalization
import java.io.File

/** Budget handed to the engine's bounded search-readiness wait
 *  (`NoteStore.waitUntilSearchReady`) — the 200×25ms this shell's former poll
 *  loop allowed. */
internal const val SEARCH_READY_TIMEOUT_MS: ULong = 5_000uL

/**
 * Reactive shell around the Rust note domain (`NoteStore`, UniFFI) — the exact
 * counterpart of the iOS `NotesStore.swift`. ALL business logic (filename/tag
 * rules, scan/preview, CRUD, folder ops) lives in `futo-notes-model` and is
 * reached through `core`; this class only holds Compose state and seeds.
 */
class NotesStore(
    notesRoot: File,
    searchIndex: File,
    initialSortOrder: NoteSortOrder = NoteSortPreference.DEFAULT,
) {
    var notes by mutableStateOf<List<NoteItem>>(emptyList())
        private set
    var folders by mutableStateOf<List<String>>(emptyList())
        private set
    var hasBootstrapped by mutableStateOf(false)
        private set
    var sortOrder by mutableStateOf(initialSortOrder)
        private set

    val rootPath: String = notesRoot.absolutePath

    /** Invoked after every local mutation (write/create/delete/rename/move/
     *  createFolder) that touches the vault on disk. The Activity wires this to
     *  [SyncManager.noteChanged] so a connected live session debounces and
     *  auto-pushes the edit to peers. Mirrors the iOS `NotesStore.onLocalChange`. */
    var onLocalChange: (() -> Unit)? = null

    /** Persists a sort order once Rust and the list have both taken it. */
    var onSortOrderChanged: ((NoteSortOrder) -> Unit)? = null

    /** When true, mutations do NOT signal [onLocalChange] — set by the full-
     *  reset flow so the bulk wipe can't trigger an auto-push mid-delete
     *  [settings.md:43]. Mirrors desktop `resetAllNotes` pausing auto-sync. */
    var suppressAutoPush = false
    private var resetting = false
    @Volatile private var vaultEpoch = 0L
    private val mutationGate = Mutex()

    // Keep the committed projection inside the same admission as its I/O.
    internal suspend fun <T> runMutationTransaction(transaction: suspend () -> T): T {
        val epoch = vaultEpoch
        return com.futo.notes.runMutationTransaction {
            mutationGate.withLock {
                check(!resetting && epoch == vaultEpoch) { "Vault mutation was retired by reset" }
                transaction()
            }
        }
    }

    /** The Rust-owned vault — the single source of truth for the rules.
     *
     *  LAZY ON PURPOSE: the Rust ctor does no I/O, but the *first* FFI touch
     *  triggers JNA's one-time `libfuto_notes_ffi.so` load (a disk read). Making
     *  `core` lazy defers that load to the first access — and every access is
     *  inside `withContext(Dispatchers.IO)`, so the native-lib load lands off the
     *  main thread instead of in the field initializer during `onCreate`. Mirrors
     *  the iOS `NoteVault` actor (the handle only ever lives off-main). */
    internal val core: NoteStore by lazy { NoteStore(rootPath) }

    /** Serializes every vault-root access, including image writes, with migration. */
    internal val storageMigrationGate = StorageMigrationGate()
    val isVaultMigrationStarted: Boolean
        get() = storageMigrationGate.isMigrationStarted

    /** Owns the background scan + every FFI mutation. State writes hop back to
     *  [Dispatchers.Main.immediate] (this scope's dispatcher) so Compose state is
     *  only ever touched on the main thread — same discipline as [SyncManager]. */
    internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val _localTreeChanges = MutableSharedFlow<SyncSummary>(extraBufferCapacity = 1)
    private var localTreeChangeTail: Job? = null

    /** Completed sync cycles, emitted after their exact list mutation is applied. */
    val localTreeChanges = _localTreeChanges.asSharedFlow()

    init {
        // Bootstrap, migrations, seeding, and search startup are one Rust call,
        // kept off-main so first render never waits for disk I/O.
        scope.launch {
            val epoch = vaultEpoch
            val bootstrap = withCore {
                core.bootstrap(searchIndex.absolutePath, initialSortOrder)
            }
            applySnapshot(bootstrap.snapshot.notes, bootstrap.snapshot.folders, epoch)
            hasBootstrapped = true
            bootstrap.warnings.forEach {
                android.util.Log.w("NotesStore", "local-note bootstrap: $it")
            }
            if (BuildConfig.DEBUG) {
                android.util.Log.i("FutoStartup", "initial scan complete: ${notes.size} notes")
            }
        }
    }

    // Fair lock on the store's own scope: picks reach Rust, the shell and the
    // preference in tap order, and leaving the list can't cancel one mid-flight.
    private val sortOrderMutex = Mutex()

    fun selectSortOrder(order: NoteSortOrder) {
        scope.launch {
            sortOrderMutex.withLock {
                if (order == sortOrder) return@withLock
                val epoch = vaultEpoch
                try {
                    val snapshot = withCore { core.setSortOrder(order) }
                    sortOrder = order
                    onSortOrderChanged?.invoke(order)
                    applySnapshot(snapshot.notes, snapshot.folders, epoch)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    android.util.Log.w("NotesStore", "sort order change failed", e)
                }
            }
        }
    }

    /** A missing note reads as empty; null means the note exists but cannot be
     *  read (bytes that are not UTF-8), so it must never open as a blank page. */
    suspend fun read(id: String): String? =
        try {
            withCore { core.read(id) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            android.util.Log.e("NotesStore", "read note failed for $id", e)
            null
        }
    suspend fun readIfExists(id: String): String? = withCore { core.readIfExists(id) }

    /** Save an editor image and consume its filename while holding the same
     * migration gate as note workflows. The consumer is part of the operation:
     * migration cannot begin until WebView insertion is confirmed.
     *
     * [deleteImageOnFailure] removes the file [save] just wrote when
     * [useSavedImage] fails or is canceled (F8) — see its doc for why. */
    suspend fun saveImageIntoVault(
        save: (File) -> String?,
        useSavedImage: suspend (String) -> Unit,
    ): String? =
        try {
            withVaultAccess {
                val filename = save(File(rootPath))
                if (filename != null) {
                    deleteImageOnFailure(File(rootPath, filename)) { useSavedImage(filename) }
                }
                filename
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            android.util.Log.e("NotesStore", "image save failed", e)
            null
        }

    /** Commits editors run after their screen has already left (main thread only). */
    internal val editorLeaves = mutableSetOf<Job>()

    /** The open editors' unsaved-draft register (F8 jetsam guard). Each editor
     *  registers ONE derivation closure via [setDraftProvider] under its own
     *  token; the Activity's onPause calls [flushPendingEditor], which pulls every
     *  live closure synchronously so an edit caught inside the 400 ms autosave
     *  debounce — even one landing right before onPause, and even in an editor
     *  still overlapping during a nav cross-fade — is persisted before the OS can
     *  kill the backgrounded process. Mirrors iOS `NotesStore.pendingDraft`. */
    internal val pendingEditor = PendingEditorDraft { draft -> flushAsync(draft) }
    internal val editorDraftCoordinator = EditorDraftCoordinator()
    internal var editorDraftTail: Job? = null

    /** Full reset [settings.md:43]: delete every note, folder, and `.crashlogs`
     *  under the vault root. Parity model: desktop `resetAllNotes`
     *  (src/app/resetAllNotes.ts). Callers pause sync + set [suppressAutoPush]
     *  for the duration and disconnect sync afterwards. */
    suspend fun deleteAll(disconnectSync: suspend () -> Unit) {
        storageMigrationGate.beginMigration()
        editorDraftCoordinator.beginReset()
        pendingEditor.reset()
        resetting = true
        vaultEpoch++
        try {
            disconnectSync()
            editorDraftTail?.join()
            localTreeChangeTail?.join()
            mutationGate.withLock {
                withContext(Dispatchers.IO) { storageMigrationGate.runMigration { core.reset() } }
                notes = emptyList()
                folders = emptyList()
            }
        } finally {
            resetting = false
            editorDraftCoordinator.endReset()
            storageMigrationGate.resume()
        }
    }

    /** Project exactly the files a sync cycle reported. Rust rechecks their
     *  final filesystem state and returns canonical row positions/folders, so
     *  this path needs neither a full vault scan nor a shell-side comparator. */
    fun localTreeChanged(summary: SyncSummary) {
        val epoch = vaultEpoch
        if (resetting) return
        val previous = localTreeChangeTail
        localTreeChangeTail = scope.launch {
            previous?.join()
            if (resetting || epoch != vaultEpoch) return@launch
            try {
                val mutation = withCore {
                    core.refreshExternalChanges(
                        summary.updatedIds,
                        summary.deletedIds,
                        summary.renamed,
                    )
                }
                if (resetting || epoch != vaultEpoch) return@launch
                applyMutation(mutation)
                _localTreeChanges.emit(summary)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                android.util.Log.w(
                    "NotesStore",
                    "scoped local-tree projection failed; rebuilding snapshot",
                    e,
                )
                try {
                    val snapshot = withCore {
                        core.rescan()
                        core.scan()
                    }
                    applySnapshot(snapshot.notes, snapshot.folders, epoch)
                } catch (fallback: CancellationException) {
                    throw fallback
                } catch (fallback: Exception) {
                    android.util.Log.e(
                        "NotesStore",
                        "local-tree snapshot recovery failed",
                        fallback,
                    )
                }
                // The list recovery is best effort, but the open editor can
                // still reconcile itself from one atomic note read.
                if (!resetting && epoch == vaultEpoch) _localTreeChanges.emit(summary)
            }
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

    internal fun signalLocalChange() {
        if (!suppressAutoPush) onLocalChange?.invoke()
    }

    private suspend fun <T> withVaultAccess(block: suspend () -> T): T {
        val admittedEpoch = vaultEpoch
        return withContext(Dispatchers.IO) {
            storageMigrationGate.runAccess {
                check(admittedEpoch == vaultEpoch) { "Vault work was retired by reset" }
                block()
            }
        }
    }

    internal suspend fun <T> withCore(block: () -> T): T = withVaultAccess(block)

    /** Immediate child folders of `folder` ("" = root). */
    fun subfolders(of: String): List<String> = immediateSubfolders(folders, of)

    /** Notes whose parent folder is exactly `folder`. */
    fun notesIn(folder: String): List<NoteItem> = notes.filter { it.folder == folder }

    private fun applySnapshot(metadata: List<NoteMetadata>, folderPaths: List<String>, epoch: Long) {
        if (resetting || epoch != vaultEpoch) return
        notes = metadata.map { it.toItem() }
        folders = folderPaths
    }

    /** Positions are post-removal; clamp them against a stale shell cache. */
    internal fun applyMutation(mutation: NoteMutation) {
        if (resetting) return
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

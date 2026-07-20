package com.futo.notes

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import uniffi.futo_notes_ffi.FlushOutcome
import uniffi.futo_notes_ffi.NoteMutation
import uniffi.futo_notes_ffi.NoteStore
import uniffi.futo_notes_ffi.NoteMetadata
import uniffi.futo_notes_ffi.SearchHit
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

/** The list's display order: most-recently-modified first, id ascending as the
 *  tiebreaker — matches the bootstrap scan's `(modified_ms desc, id asc)`
 *  (futo-notes-model `scan_notes`) so an in-place resort is identical to a
 *  fresh reload. Pinned by NoteListRepinTest. */
internal val noteListOrder: Comparator<NoteItem> =
    compareByDescending<NoteItem> { it.modifiedMs }.thenBy { it.id }

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

/** Whether a migration flush proved that the live draft is represented on disk. */
internal fun pendingDraftIsDurable(
    outcome: FlushOutcome,
    hasMutation: Boolean,
    diskContent: String?,
    draftContent: String,
): Boolean = when (outcome) {
    FlushOutcome.WROTE -> hasMutation || diskContent == draftContent
    FlushOutcome.SKIPPED_CHANGED -> diskContent == draftContent
    FlushOutcome.SKIPPED_MISSING -> false
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

    /** A newly-composed editor claims an entry; returns its unique generation
     *  token (the map key). Registration/removal are keyed by it, so editors
     *  overlapping during a cross-fade never touch each other's entry. */
    fun claim(): Long = ++seq

    /** The editor registers (or re-registers) its derivation closure under its
     *  own [token]. Never evicts another editor's entry. */
    fun setProvider(token: Long, provider: () -> PendingDraft?) {
        providers[token] = provider
    }

    /** The editor left composition — removes only its own entry, leaving any
     *  overlapping editor's provider intact. */
    fun release(token: Long) {
        providers.remove(token)
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

    /** Serializes every FFI vault access with storage migration. */
    private val vaultAccess = Mutex()
    @Volatile private var vaultMigrationStarted = false

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

    /** Fire-and-forget flush for the editor's leave paths (`onDispose` on pop,
     *  and the register's onPause flush): a composable's dispose callback can't
     *  suspend, so the final save runs on the store's scope (which outlives the
     *  screen).
     *
     *  A conditional write (`write_if_unchanged`): persist `draft.content` only
     *  if the note still holds `draft.base` (the content the editor last saw).
     *  One FFI call replaces the old `exists()`-then-`write()` sequence,
     *  collapsing its cross-FFI TOCTOU — a note deleted while backgrounded
     *  returns SkippedMissing (never resurrected), and content a live-sync pull
     *  adopted since the editor's last read returns SkippedChanged (never
     *  clobbered). Check-then-atomic-write, not a true CAS (a narrow residual
     *  syscall window is accepted — see the Rust doc). Only a genuine write
     *  (WROTE) updates in-memory state. */
    fun flushAsync(draft: PendingDraft) {
        scope.launch {
            // Swallow-and-log, mirroring [write]. `writeIfUnchanged` throws
            // NoteException on a non-NotFound IO error (temp-write ENOSPC, EACCES
            // read); this runs on a fire-and-forget scope with no exception
            // handler, so an uncaught throw here would crash the process at
            // leave-foreground. A failed background flush must degrade to "not
            // flushed" (the debounce / next flush retries), never crash.
            try {
                val result = withCore {
                    core.writeIfUnchanged(draft.id, draft.base, draft.content)
                }
                result.mutation?.let {
                    applyMutation(it)
                    signalLocalChange()
                }
            } catch (e: Exception) {
                android.util.Log.e("NotesStore", "flush failed for ${draft.id}", e)
            }
        }
    }

    /** The open editors' unsaved-draft register (F8 jetsam guard). Each editor
     *  registers ONE derivation closure via [setDraftProvider] under its own
     *  token; the Activity's onPause calls [flushPendingEditor], which pulls every
     *  live closure synchronously so an edit caught inside the 400 ms autosave
     *  debounce — even one landing right before onPause, and even in an editor
     *  still overlapping during a nav cross-fade — is persisted before the OS can
     *  kill the backgrounded process. Mirrors iOS `NotesStore.pendingDraft`. */
    private val pendingEditor = PendingEditorDraft { draft -> flushAsync(draft) }

    /** A newly-composed editor claims a register entry; returns its unique token.
     *  Entries are keyed by it, so editors overlapping during the AnimatedContent
     *  cross-fade never evict each other's provider (PKT-1 R2 / PKT-12 G1). */
    fun claimDraftOwnership(): Long = pendingEditor.claim()

    /** The editor registers its derivation closure under its [token] — evaluated
     *  synchronously at flush time (onPause). Replaces the old hand-synced
     *  set/clear sites: the register reflects the editor's live state on demand. */
    fun setDraftProvider(token: Long, provider: () -> PendingDraft?) =
        pendingEditor.setProvider(token, provider)

    /** The editor left composition — removes only its own entry, leaving any
     *  overlapping editor's provider intact. */
    fun releaseDraftOwnership(token: Long) = pendingEditor.release(token)

    /** Flush the open editor's pending draft to disk if it has unsaved edits.
     *  Called from MainActivity.onPause (the first leave-foreground signal).
     *  Fire-and-forget via [flushAsync], which re-checks existence off-main so a
     *  note deleted while open is never resurrected. Mirrors iOS `flushPendingEditor`.
     *  Best-effort: the write is fire-and-forget, so an immediate process death
     *  can still beat it (same on iOS). */
    fun flushPendingEditor() = pendingEditor.flush()

    /**
     * Flush live editor drafts and hold the vault gate across migration. Existing
     * store operations finish before the copy starts; the Activity blocks new UI
     * input and pauses sync before calling this method.
     */
    suspend fun migrateVault(to: File): NotesStorage.MigrationOutcome {
        vaultMigrationStarted = true
        val drafts = pendingEditor.currentDrafts()
        val mutations = mutableListOf<NoteMutation>()
        val outcome = withContext(Dispatchers.IO) {
            vaultAccess.withLock {
                val flushFailed = drafts.any { draft ->
                    val result = core.writeIfUnchanged(draft.id, draft.base, draft.content)
                    val mutation = result.mutation
                    val diskContent = if (result.outcome != FlushOutcome.WROTE || mutation == null) {
                        if (core.exists(draft.id)) core.read(draft.id) else null
                    } else {
                        null
                    }
                    val durable = pendingDraftIsDurable(
                        outcome = result.outcome,
                        hasMutation = mutation != null,
                        diskContent = diskContent,
                        draftContent = draft.content,
                    )
                    if (durable) mutation?.let(mutations::add)
                    !durable
                }
                if (flushFailed) {
                    NotesStorage.MigrationOutcome.Failed(
                        "An open editor change could not be saved. The storage mode was not changed.",
                    )
                } else {
                    NotesStorage.migrate(File(rootPath), to)
                }
            }
        }
        mutations.forEach(::applyMutation)
        return outcome
    }

    /** Re-open the old root after a migration or preference-commit failure. */
    fun resumeAfterStorageMigrationFailure() {
        vaultMigrationStarted = false
    }

    /** Write one note and consume the complete committed mutation. */
    suspend fun write(id: String, content: String): NoteMutationOutcome<Unit> =
        try {
            val mutation = withCore { core.write(id, content) }
            applyMutation(mutation)
            signalLocalChange()
            NoteMutationOutcome.Committed(Unit)
        } catch (e: Exception) {
            android.util.Log.e("NotesStore", "write failed for $id", e)
            NoteMutationOutcome.Failed
        }

    /** Re-sort the in-memory list most-recently-modified first WITHOUT a rescan
     *  [list.md:24]. `write` keeps row identity/order stable while typing (so a
     *  resort can't pop the open editor out from under the user); this sorts what
     *  is already in memory and is called when a pop lands back on the list
     *  (AppShell.pop). Pure state swap on main — no FFI, no I/O. */
    fun resortInPlace() {
        notes = notes.sortedWith(noteListOrder)
    }

    suspend fun createNote(title: String, folder: String = ""): String? = try {
        val mutation = withCore { core.createNote(title, folder, "") }
        applyMutation(mutation)
        refreshFolders()
        signalLocalChange()
        mutation.finalId(title)
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "createNote failed", e); null
    }

    suspend fun delete(id: String) {
        try {
            val mutation = withCore { core.delete(id) }
            applyMutation(mutation)
            refreshFolders()
            signalLocalChange()
        } catch (e: Exception) { android.util.Log.e("NotesStore", "delete failed", e) }
    }

    /** Fire-and-forget delete for the editor's `onDispose` (can't suspend; the
     *  composable's scope is already gone). Runs on the store's scope, which
     *  outlives the screen — used to discard an untouched quick-capture note on
     *  back-out (NoteEditorScreen.kt onDispose). Mirrors [flushAsync]. */
    fun deleteAsync(id: String) {
        scope.launch { delete(id) }
    }

    suspend fun rename(oldId: String, newId: String): String = try {
        val mutation = withCore { core.rename(oldId, newId) }
        applyMutation(mutation)
        refreshFolders()
        signalLocalChange()
        mutation.finalId(oldId)
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "rename failed", e); oldId
    }

    suspend fun moveNote(id: String, toFolder: String): String = try {
        val mutation = withCore { core.moveNote(id, toFolder) }
        applyMutation(mutation)
        refreshFolders()
        signalLocalChange()
        mutation.finalId(id)
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "moveNote failed", e); id
    }

    suspend fun createFolder(path: String) {
        try {
            withCore { core.createFolder(path) }
            refreshFolders()
            signalLocalChange()
        } catch (e: Exception) {
            android.util.Log.e("NotesStore", "createFolder failed", e)
        }
    }

    /** MOVE-UP folder delete (Tauri parity, [list.md:121]): notes under
     *  [path] move to the parent (Rust bails atomically — if ANY move fails
     *  nothing is deleted), wikilinks are relinked, then the folder tree goes.
     *  Returns the moved-note count, or null when the FFI rejected the delete
     *  (the folder is left intact). */
    suspend fun deleteFolder(path: String): UInt? = try {
        val mutation = withCore { core.deleteFolder(path) }
        applyMutation(mutation)
        refreshFolders()
        signalLocalChange()
        mutation.renamed.size.toUInt()
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "deleteFolder failed for $path", e); null
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

    /** No shell-owned search or fallback: wait briefly for the Rust owner and
     *  return its ranked result set. */
    suspend fun search(query: String, limit: UInt = 50u): List<SearchHit> {
        repeat(200) {
            if (withCore { core.keywordReady() }) {
                return withCore { core.search(query, limit) }
            }
            delay(25)
        }
        return emptyList()
    }

    private fun signalLocalChange() {
        if (!suppressAutoPush) onLocalChange?.invoke()
    }

    private suspend fun <T> withCore(block: () -> T): T =
        withContext(Dispatchers.IO) {
            vaultAccess.withLock {
                check(!vaultMigrationStarted) { "Vault access is paused for storage migration" }
                block()
            }
        }

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

    /** The sole incremental cache seam. Rust has already committed collision
     *  outcomes and every backlink rewrite represented by this result. */
    private fun applyMutation(mutation: NoteMutation) {
        val removed = mutation.removed.toSet()
        val next = notes.filterNot { it.id in removed }.toMutableList()
        mutation.upserted.forEach { metadata ->
            val item = metadata.toItem()
            val index = next.indexOfFirst { it.id == item.id }
            if (index >= 0) next[index] = item else next.add(0, item)
        }
        notes = next
        mutation.warnings.forEach {
            android.util.Log.w("NotesStore", "local-note mutation: $it")
        }
    }

    private suspend fun refreshFolders() {
        folders = withCore { core.scan().folders }
    }

    private fun NoteMutation.finalId(fallback: String): String =
        renamed.lastOrNull()?.to ?: upserted.firstOrNull()?.id ?: fallback

    private fun NoteMetadata.toItem() =
        NoteItem(id, title, folder, modifiedMs, preview, richPreview, tags)
}

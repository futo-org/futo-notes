package com.futo.notes

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.futo_notes_ffi.NoteStore
import uniffi.futo_notes_ffi.NoteMetadata
import uniffi.futo_notes_ffi.SearchEngine
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
        val byId = LinkedHashMap<String, PendingDraft>()
        providers.values.toList().forEach { provider -> provider()?.let { byId[it.id] = it } }
        byId.values.forEach { persist(it) }
    }
}

/**
 * Reactive shell around the Rust note domain (`NoteStore`, UniFFI) — the exact
 * counterpart of the iOS `NotesStore.swift`. ALL business logic (filename/tag
 * rules, scan/preview, CRUD, folder ops) lives in `futo-notes-model` and is
 * reached through `core`; this class only holds Compose state and seeds.
 */
class NotesStore(notesRoot: File) {
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
     *  [settings.md:43]. Mirrors desktop `deleteAllNotes` pausing auto-sync. */
    var suppressAutoPush = false

    /** The BM25 keyword search engine. Set once by the Activity
     *  after off-main construction (the Tantivy index open does disk I/O and
     *  must never gate render); null until then — SearchScreen falls back to
     *  substring filtering. Mutations below feed it incremental notify calls. */
    var engine: SearchEngine? = null

    /** The Rust-owned vault — the single source of truth for the rules.
     *
     *  LAZY ON PURPOSE: the Rust ctor does no I/O, but the *first* FFI touch
     *  triggers JNA's one-time `libfuto_notes_ffi.so` load (a disk read). Making
     *  `core` lazy defers that load to the first access — and every access is
     *  inside `withContext(Dispatchers.IO)`, so the native-lib load lands off the
     *  main thread instead of in the field initializer during `onCreate`. Mirrors
     *  the iOS `NoteVault` actor (the handle only ever lives off-main). */
    private val core: NoteStore by lazy { NoteStore(rootPath) }

    /** Owns the background scan + every FFI mutation. State writes hop back to
     *  [Dispatchers.Main.immediate] (this scope's dispatcher) so Compose state is
     *  only ever touched on the main thread — same discipline as [SyncManager]. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    init {
        // CRITICAL: never gate render on disk I/O. The constructor touches NO
        // disk on the main thread — `core` is lazy (its first JNA lib-load is
        // deferred to the IO block below) and the `mkdirs()` + first vault scan
        // + seed all run off the main thread, populating `notes`/`folders`
        // reactively. The list shows empty state until the scan lands — the
        // shell never waits. Mirrors the Tauri never-gate-render rule
        // (App.svelte fires `notes_scan` un-awaited).
        scope.launch {
            withContext(Dispatchers.IO) {
                File(rootPath).mkdirs()
                seedIfEmpty() // first `core` touch → JNA lib-load happens here, off-main
            }
            reload()
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
        val scanned = withContext(Dispatchers.IO) {
            core.scanNotes().map { it.toItem() } to core.scanFolders()
        }
        notes = scanned.first
        folders = scanned.second
    }

    suspend fun read(id: String): String = withContext(Dispatchers.IO) { core.read(id) }
    suspend fun exists(id: String): Boolean = withContext(Dispatchers.IO) { core.exists(id) }

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
                val outcome = withContext(Dispatchers.IO) {
                    core.writeIfUnchanged(draft.id, draft.base, draft.content)
                }
                if (outcome == uniffi.futo_notes_ffi.FlushOutcome.WROTE) {
                    applyWrittenContent(draft.id, draft.content)
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

    /** Write a note, updating the in-memory row in place (no full rescan) so the
     *  list's identity/order stays stable while typing — mirrors the iOS
     *  in-place optimization. Preview + tags come from the same Rust rules. The
     *  FFI write + preview/tag derivation run on IO; the state swap is on main. */
    suspend fun write(id: String, content: String) {
        try {
            withContext(Dispatchers.IO) { core.write(id, content) }
            applyWrittenContent(id, content)
        } catch (e: Exception) {
            android.util.Log.e("NotesStore", "write failed for $id", e)
        }
    }

    /** Reflect a write of [content] to [id] that already landed on disk into the
     *  in-memory list, search engine, and auto-push signal — the post-write
     *  bookkeeping shared by [write] and [flushAsync]'s conditional write.
     *  Updates the row IN PLACE (stable identity/order while typing); a note not
     *  in the list yet triggers a rescan. Preview + tags come from the same Rust
     *  rules the scan uses. */
    private suspend fun applyWrittenContent(id: String, content: String) {
        val derived = withContext(Dispatchers.IO) {
            Triple(
                uniffi.futo_notes_ffi.makePreview(content),
                uniffi.futo_notes_ffi.makeRichPreview(content),
                uniffi.futo_notes_ffi.extractTags(content),
            )
        }
        val idx = notes.indexOfFirst { it.id == id }
        if (idx >= 0) {
            val old = notes[idx]
            val updated = old.copy(
                modifiedMs = System.currentTimeMillis(),
                preview = derived.first,
                richPreview = derived.second,
                tags = derived.third,
            )
            notes = notes.toMutableList().also { it[idx] = updated }
        } else {
            reload()
        }
        signalLocalChange()
        notifyEngine { it.notifyChanged("$id.md") }
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
        val id = withContext(Dispatchers.IO) { core.createNote(title, folder) }
        reload()
        signalLocalChange()
        notifyEngine { it.notifyChanged("$id.md") }
        id
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "createNote failed", e); null
    }

    suspend fun delete(id: String) {
        try {
            withContext(Dispatchers.IO) { core.delete(id) }
            signalLocalChange()
            notifyEngine { it.notifyRemoved("$id.md") }
        } catch (e: Exception) { android.util.Log.e("NotesStore", "delete failed", e) }
        reload()
    }

    /** Fire-and-forget delete for the editor's `onDispose` (can't suspend; the
     *  composable's scope is already gone). Runs on the store's scope, which
     *  outlives the screen — used to discard an untouched quick-capture note on
     *  back-out (NoteEditorScreen.kt onDispose). Mirrors [flushAsync]. */
    fun deleteAsync(id: String) {
        scope.launch { delete(id) }
    }

    suspend fun rename(oldId: String, newId: String): String = try {
        val finalId = withContext(Dispatchers.IO) { core.rename(oldId, newId) }
        reload(); signalLocalChange()
        notifyEngine { it.notifyRenamed("$oldId.md", "$finalId.md") }
        finalId
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "rename failed", e); oldId
    }

    suspend fun moveNote(id: String, toFolder: String): String = try {
        val finalId = withContext(Dispatchers.IO) { core.moveNote(id, toFolder) }
        reload(); signalLocalChange()
        notifyEngine { it.notifyRenamed("$id.md", "$finalId.md") }
        finalId
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "moveNote failed", e); id
    }

    suspend fun createFolder(path: String) {
        try {
            withContext(Dispatchers.IO) { core.createFolder(path) }
            reload(); signalLocalChange()
        } catch (e: Exception) {
            android.util.Log.e("NotesStore", "createFolder failed", e)
        }
    }

    /** Vault-wide wikilink rewrite after a rename/move [editor.md:88]: every
     *  link that resolved to [oldId] is repointed at [newId]. Fire-and-forget
     *  on the store's scope — the rewrite touches many files and may outlive
     *  the editor screen that triggered it. Rewritten bodies belong to ids the
     *  Rust side doesn't enumerate, so the engine gets a full rescan. */
    fun relink(oldId: String, newId: String) {
        if (oldId == newId) return
        scope.launch {
            try {
                val rewritten = withContext(Dispatchers.IO) { core.relink(oldId, newId) }
                if (rewritten > 0u) {
                    reload()
                    signalLocalChange()
                    notifyEngine { it.rescan() }
                }
            } catch (e: Exception) {
                android.util.Log.e("NotesStore", "relink failed $oldId -> $newId", e)
            }
        }
    }

    /** MOVE-UP folder delete (Tauri parity, [list.md:121]): notes under
     *  [path] move to the parent (Rust bails atomically — if ANY move fails
     *  nothing is deleted), wikilinks are relinked, then the folder tree goes.
     *  Returns the moved-note count, or null when the FFI rejected the delete
     *  (the folder is left intact). */
    suspend fun deleteFolder(path: String): UInt? = try {
        val moved = withContext(Dispatchers.IO) { core.deleteFolder(path) }
        reload(); signalLocalChange()
        // The moved notes' new ids aren't enumerated across the FFI — rescan.
        notifyEngine { it.rescan() }
        moved
    } catch (e: Exception) {
        android.util.Log.e("NotesStore", "deleteFolder failed for $path", e); null
    }

    /** Full reset [settings.md:43]: delete every note, folder, and `.crashlogs`
     *  under the vault root. Parity model: desktop `deleteAllNotes`
     *  (src/lib/notes.svelte.ts). Callers pause sync + set [suppressAutoPush]
     *  for the duration and disconnect sync afterwards. */
    suspend fun deleteAll() {
        withContext(Dispatchers.IO) {
            File(rootPath).listFiles()?.forEach { it.deleteRecursively() }
        }
        reload()
        notifyEngine { it.rescan() }
    }

    /** Full engine rescan for bulk disk changes whose affected ids aren't
     *  enumerable — wired to [SyncManager.onLivePull] by the Activity. */
    fun engineRescanAsync() {
        notifyEngine { it.rescan() }
    }

    private fun signalLocalChange() {
        if (!suppressAutoPush) onLocalChange?.invoke()
    }

    /** Engine notifications are FFI calls (index I/O) — always off-main, and
     *  never allowed to break the mutation that triggered them. */
    private fun notifyEngine(block: (SearchEngine) -> Unit) {
        val e = engine ?: return
        scope.launch(Dispatchers.IO) {
            runCatching { block(e) }
                .onFailure { android.util.Log.e("NotesStore", "search engine notify failed", it) }
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

    private fun NoteMetadata.toItem() =
        NoteItem(id, title, folder, modifiedMs, preview, richPreview, tags)

    private fun seedIfEmpty() {
        // Seed content lives in futo-notes-model (`seed_if_empty`) so Android,
        // iOS, and desktop share one user-facing first run that can't drift.
        runCatching { core.seedIfEmpty() }
    }
}

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
    val preview: String,
    val tags: List<String>,
)

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

    /** The BM25 keyword search engine [search.md:60]. Set once by the Activity
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

    /** Fire-and-forget flush for the editor's `onDispose`: a composable's dispose
     *  callback can't suspend, and the editor's own scope is gone by then, so the
     *  final save runs on the store's scope (which outlives the screen). The
     *  exists-check + write happen on IO; `write` keeps `notes` in sync. */
    fun flushAsync(id: String, content: String) {
        scope.launch {
            if (withContext(Dispatchers.IO) { core.exists(id) }) write(id, content)
        }
    }

    /** Write a note, updating the in-memory row in place (no full rescan) so the
     *  list's identity/order stays stable while typing — mirrors the iOS
     *  in-place optimization. Preview + tags come from the same Rust rules. The
     *  FFI write + preview/tag derivation run on IO; the state swap is on main. */
    suspend fun write(id: String, content: String) {
        try {
            val derived = withContext(Dispatchers.IO) {
                core.write(id, content)
                uniffi.futo_notes_ffi.makePreview(content) to uniffi.futo_notes_ffi.extractTags(content)
            }
            val idx = notes.indexOfFirst { it.id == id }
            if (idx >= 0) {
                val old = notes[idx]
                val updated = old.copy(
                    modifiedMs = System.currentTimeMillis(),
                    preview = derived.first,
                    tags = derived.second,
                )
                notes = notes.toMutableList().also { it[idx] = updated }
            } else {
                reload()
            }
            signalLocalChange()
            notifyEngine { it.notifyChanged("$id.md") }
        } catch (e: Exception) {
            android.util.Log.e("NotesStore", "write failed for $id", e)
        }
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

    private fun NoteMetadata.toItem() = NoteItem(id, title, folder, modifiedMs, preview, tags)

    private fun seedIfEmpty() {
        if (core.scanNotes().isNotEmpty()) return
        runCatching {
            core.write(
                "Welcome",
                """
                # Welcome to FUTO Notes

                This is a **native Android** shell. The note list, folders, and
                navigation are native Compose — only the editor below is a web view,
                the SAME editor.html the iOS and desktop apps use.

                Try the #welcome and #android tags.
                """.trimIndent(),
            )
            core.write("Specs/Folder support", "# Folder support\n\nNotes can live in folders.\n\n#spec")
        }
    }
}

import Foundation
import Combine

/// Off-main owner of the Rust `NoteStore` (UniFFI) handle. ALL filesystem I/O
/// (scan/read/write/CRUD/folder ops) runs on this actor's executor, NEVER on
/// the main actor — so a slow/cold-sandbox scan can only delay list population,
/// never the first frame (see CLAUDE.md "never gate UI render on filesystem
/// I/O"). The Rust object is `Arc`-backed with an immutable root and is
/// `Send + Sync`, so serializing access through one actor is both safe and the
/// single point where blocking FS calls happen.
///
/// `@unchecked Sendable`: the generated `NoteStore` binding isn't marked
/// `Sendable`, but the underlying Rust object is thread-safe and this actor is
/// the only thing that ever touches the handle.
actor NoteVault {
    private let core: NoteStore

    init(notesRoot: String) {
        // The Rust constructor does NO I/O — safe to build eagerly. The dir is
        // created lazily on first write/scan below.
        self.core = NoteStore(notesRoot: notesRoot)
    }

    /// One-time bootstrap: ensure the root dir exists, seed the welcome notes if
    /// the vault is empty, then return the initial scan. Runs entirely off-main.
    func bootstrap(notesRoot: String) -> (notes: [NoteMetadata], folders: [String]) {
        try? FileManager.default.createDirectory(
            atPath: notesRoot, withIntermediateDirectories: true)
        seedIfEmpty()
        return (core.scanNotes(), core.scanFolders())
    }

    func scan() -> (notes: [NoteMetadata], folders: [String]) {
        (core.scanNotes(), core.scanFolders())
    }

    func read(_ id: String) -> String { core.read(id: id) }
    func exists(_ id: String) -> Bool { core.exists(id: id) }

    /// Write content, returning the up-to-date preview/tags for an in-place row
    /// refresh (so the caller never has to re-derive rules — same Rust source).
    func write(_ id: String, content: String) throws -> (preview: String, tags: [String]) {
        try core.write(id: id, content: content)
        return (makePreview(content: content), extractTags(content: content))
    }

    func createNote(title: String, folder: String) throws -> String {
        try core.createNote(title: title, folder: folder)
    }

    func delete(_ id: String) throws { try core.delete(id: id) }

    func rename(oldId: String, newId: String) throws -> String {
        let finalId = try core.rename(oldId: oldId, newId: newId)
        // Rewrite every wikilink vault-wide that resolved to the old id so it
        // points at the new one (Rust relink, same rules as Tauri). Runs inside
        // the actor so no scan can observe the moved-but-not-relinked window. A
        // relink failure must not fail the rename — the file already moved;
        // stale links are the lesser evil.
        _ = try? core.relink(oldId: oldId, newId: finalId)
        return finalId
    }

    func moveNote(_ id: String, folder: String) throws -> String {
        let finalId = try core.moveNote(id: id, folder: folder)
        // Same wikilink rewrite as rename — a move changes the id too.
        _ = try? core.relink(oldId: id, newId: finalId)
        return finalId
    }

    /// Delete a folder with MOVE-UP semantics (Tauri parity): every note under
    /// it moves to the parent (folder segment removed, wikilinks relinked); the
    /// now-note-empty folder tree is then removed. All-or-nothing in one Rust
    /// call. Returns the moved-note count.
    func deleteFolder(_ folder: String) throws -> UInt32 {
        try core.deleteFolder(folder: folder)
    }

    func createFolder(_ path: String) throws -> String {
        try core.createFolder(path: path)
    }

    // MARK: - Seeding (runs on the actor, off-main)

    private func seedIfEmpty() {
        guard core.scanNotes().isEmpty else { return }

        let welcome = """
        # Welcome to FUTO Notes

        This is a **native iOS** spike. The note list, folders, and navigation \
        are all native SwiftUI — only the editor below is a web view.

        - Offline-first markdown
        - Tap a note to edit it
        - Swipe a row to delete

        Try the #welcome and #spike tags.
        """

        let demo = """
        # Markdown demo

        Some **bold**, some *italic*, and `inline code`.

        ## A list
        - First
        - Second
        - Third

        ## Checkboxes
        - [x] Build native list
        - [ ] Ship it

        ## A table
        | Feature | Status |
        | ------- | ------ |
        | List    | done   |
        | Editor  | wip    |

        Tagged #demo #markdown.
        """

        let spec = """
        # Folder support

        Notes can live in folders. This note lives under `Specs/`.

        The note id is its path relative to the root, without `.md`.

        #spec
        """

        try? core.write(id: "Welcome", content: welcome)
        try? core.write(id: "Markdown demo", content: demo)
        try? core.write(id: "Specs/Folder support", content: spec)
    }
}

/// Reactive shell around the Rust note domain. Owns the `@Published`
/// note/folder state the SwiftUI views observe; ALL business logic
/// (filename/tag/title rules, scan/preview, CRUD, folder ops) lives in
/// `futo-notes-model` and is reached through `NoteVault` → `core`. This type is
/// presentation glue only — like `SyncManager` for sync.
///
/// Concurrency: every method that touches disk `await`s the off-main
/// `NoteVault`, then publishes results back on the main actor. The first frame
/// renders with empty `notes`/`folders`; the initial scan populates them
/// reactively (see `init`).
@MainActor
final class NotesStore: ObservableObject {
    @Published private(set) var notes: [NoteItem] = []
    /// All folder paths relative to root (e.g. "Specs", "Specs/Drafts"),
    /// including empty folders on disk + folders implied by note ids. Sorted.
    @Published private(set) var folders: [String] = []

    /// False until the first background scan (`bootstrap`) lands. The list must
    /// NOT show its "No notes yet" empty state while this is false — on a cold
    /// start `notes` is `[]` purely because the scan hasn't completed, and
    /// flashing the empty state before the notes appear reads as data loss.
    /// (We deliberately render with an empty list rather than gate the first
    /// frame on I/O — see `init` — so this flag is how the UI tells "still
    /// loading" apart from "genuinely empty".)
    @Published private(set) var hasBootstrapped: Bool = false

    /// The notes root, created on first vault access (NOT in init — init must
    /// not touch disk).
    let notesRoot: URL

    /// Invoked after every local mutation (write/create/delete/rename/move/
    /// createFolder) that touches the vault on disk. The app wires this to
    /// `SyncManager.noteChanged` so a connected live session debounces and
    /// auto-pushes the edit to peers. Mirrors Android's `NotesStore.onLocalChange`.
    var onLocalChange: (() -> Void)?

    /// The currently-open editor's UNSAVED draft (id + content), or `nil` when no
    /// editor is open or its draft is clean. The open editor keeps this current
    /// via `setPendingDraft` on every keystroke and clears it on disappear. The
    /// app's scenePhase handler calls `flushPendingEditor()` when leaving
    /// `.active`, so an edit caught inside the 400 ms autosave debounce is
    /// persisted before the OS can jetsam the app (data-loss guard, F8). Pushed
    /// down here so the scenePhase handler never reaches into editor internals.
    /// Mirrors Android's onStop flush path.
    ///
    /// A stored tuple (not a closure capturing the editor's struct `@State`) so
    /// the value is always the last one the editor explicitly published — capturing
    /// a SwiftUI View struct's `@State` in a long-lived closure is unreliable.
    private var pendingDraft: (id: String, content: String)?

    /// The editor publishes its current unsaved draft here (id + content), or
    /// `nil` when clean / closed.
    func setPendingDraft(_ draft: (id: String, content: String)?) {
        pendingDraft = draft
    }

    /// Flush the open editor's pending draft to disk if it has unsaved edits.
    /// Called from the app's scenePhase background/inactive handler. Fire-and-
    /// forget via `flushAsync`, which re-checks existence off-main so a note
    /// deleted while open is never resurrected.
    func flushPendingEditor() {
        guard let draft = pendingDraft else { return }
        flushAsync(draft.id, content: draft.content)
    }

    /// The off-main owner of the Rust vault. The single source of truth for the
    /// rules. All FS I/O happens behind this actor.
    private let vault: NoteVault

    /// Off-main owner of the lazy Rust `SearchEngine` (BM25). Store mutations
    /// feed it incremental notify* calls; live pulls trigger a rescan. The list
    /// UI queries it directly (NoteListView), falling back to substring search
    /// while the index warms.
    let search: SearchService

    init() {
        let root = NotesStore.resolveNotesRoot()
        // Log the active sandbox root so a "synced but no notes" report is
        // diagnosable from device logs: distinct app installs (dev/release/custom
        // bundle ids) use SEPARATE Documents containers, so notes pulled by one
        // install never appear in another. Surfaced in the UI too (SyncView).
        NSLog("[NotesStore] notesRoot = \(root.path)")
        self.notesRoot = root
        self.vault = NoteVault(notesRoot: root.path)
        self.search = SearchService(notesRoot: root.path)
        // CRITICAL: do NOT scan/seed synchronously here — that would gate the
        // first frame on filesystem I/O. Fire a background bootstrap; the list
        // populates reactively when it lands.
        Task { await bootstrap() }
    }

    /// Resolve the notes root WITHOUT touching disk. Debug builds use a separate
    /// data root (Documents/fake-notes) so a dev/debug install can never read or
    /// write the user's real notes — mirrors the Tauri debug guard
    /// (default_notes_root → ~/Documents/fake-notes). Release uses the prod root.
    /// Internal (not private) and nonisolated: the futo-asset scheme handler
    /// and the crash reporter resolve the same root without holding a
    /// `NotesStore` (or hopping to the main actor — no actor state is touched).
    nonisolated static func resolveNotesRoot() -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        #if FUTO_DEBUG_BUILD
        return docs.appendingPathComponent("fake-notes", isDirectory: true)
        #else
        return docs.appendingPathComponent("futo-notes", isDirectory: true)
        #endif
    }

    private func bootstrap() async {
        let (metas, folders) = await vault.bootstrap(notesRoot: notesRoot.path)
        self.notes = metas.map(Self.item(from:))
        self.folders = folders
        // First scan has landed: the empty state may now be trusted.
        self.hasBootstrapped = true
    }

    // MARK: - Scan / reload (delegates to the off-main vault)

    func reload() {
        Task {
            let (metas, folders) = await vault.scan()
            self.notes = metas.map(Self.item(from:))
            self.folders = folders
        }
    }

    /// Resort the existing in-memory `notes` by most-recently-modified first,
    /// WITHOUT a rescan or any FFI call — just sort the array already in memory.
    /// `write` deliberately refreshes a row IN PLACE (no resort) so per-keystroke
    /// edits don't churn List diffing or pop the pushed editor out from under the
    /// user. On mobile the list isn't visible while editing (the editor is a
    /// full-screen NavigationStack push), so the list is resorted when it
    /// re-appears after the editor pops (FolderContentsView.onAppear), not on
    /// keystroke. The key matches the bootstrap scan's `(modified_ms desc,
    /// id asc)` (crud.rs scan_notes) so the order is identical to a fresh scan.
    /// [list.md:24]
    func resortInPlace() {
        notes.sort { a, b in
            if a.modified != b.modified { return a.modified > b.modified }
            return a.id < b.id
        }
    }

    /// Map a Rust `NoteMetadata` to the SwiftUI `NoteItem` (ms → Date).
    private static func item(from meta: NoteMetadata) -> NoteItem {
        NoteItem(
            id: meta.id,
            title: meta.title,
            folder: meta.folder,
            modified: Date(timeIntervalSince1970: Double(meta.modifiedMs) / 1000.0),
            preview: meta.preview,
            tags: meta.tags
        )
    }

    // MARK: - CRUD (delegates to the off-main vault)

    /// Read a note's content off-main. Returns "" if missing.
    func read(_ id: String) async -> String { await vault.read(id) }

    /// Whether a note file currently exists on disk (off-main).
    func exists(_ id: String) async -> Bool { await vault.exists(id) }

    /// Write a note's content. `await`able so the editor can flush a pending
    /// save (on rename / background) and KNOW it landed before the file moves.
    func write(_ id: String, content: String) async {
        do {
            let (preview, tags) = try await vault.write(id, content: content)
            // Update the in-memory note in place instead of a full rescan +
            // resort. Reassigning the whole `notes` array on every keystroke
            // churns the List's diffing and pops the pushed editor out from
            // under the user. In-place keeps row identity/order stable while
            // refreshing the preview/tags. Structural changes (create / delete
            // / rename) still call reload(). Preview + tags come from the same
            // Rust rules the scan uses.
            if let idx = notes.firstIndex(where: { $0.id == id }) {
                let old = notes[idx]
                notes[idx] = NoteItem(
                    id: old.id,
                    title: old.title,
                    folder: old.folder,
                    modified: Date(),
                    preview: preview,
                    tags: tags
                )
            } else {
                reload()
            }
            search.noteChanged(id)
            onLocalChange?()
        } catch {
            print("write failed for \(id): \(error)")
        }
    }

    /// Create a new note. Returns its id, or nil on failure.
    @discardableResult
    func createNote(title: String, folder: String = "") async -> String? {
        do {
            let id = try await vault.createNote(title: title, folder: folder)
            reload()
            search.noteChanged(id)
            onLocalChange?()
            return id
        } catch {
            print("createNote failed: \(error)")
            return nil
        }
    }

    func delete(_ id: String) {
        Task {
            do {
                try await vault.delete(id)
                search.noteRemoved(id)
                onLocalChange?()
            } catch { print("delete failed for \(id): \(error)") }
            reload()
        }
    }

    /// Move/rename a note from oldId to newId. Returns the final id.
    @discardableResult
    func rename(oldId: String, newId: String) async -> String {
        do {
            let finalId = try await vault.rename(oldId: oldId, newId: newId)
            reload()
            search.noteRenamed(from: oldId, to: finalId)
            onLocalChange?()
            return finalId
        } catch {
            print("rename failed \(oldId) -> \(newId): \(error)")
            return oldId
        }
    }

    /// Fire-and-forget flush of a pending edit from a context that cannot
    /// `await` — `NoteEditorView.onDisappear` and the app's scenePhase
    /// background handler. Runs on the store (main-actor) but `await`s the
    /// off-main vault write, so the file is persisted even though the caller
    /// returns immediately. Re-checks existence inside the task so a note
    /// deleted while open is never resurrected. Mirrors Android's
    /// `NotesStore.flushAsync` (NoteEditorScreen.kt onDispose / onStop).
    func flushAsync(_ id: String, content: String) {
        Task {
            guard await vault.exists(id) else { return }
            await write(id, content: content)
        }
    }

    // MARK: - Folders

    /// Move a note into `folder` (use "" for root), keeping its title leaf.
    /// Returns the note's final id.
    @discardableResult
    func moveNote(_ id: String, toFolder folder: String) async -> String {
        do {
            let finalId = try await vault.moveNote(id, folder: folder)
            reload()
            search.noteRenamed(from: id, to: finalId)
            onLocalChange?()
            return finalId
        } catch {
            print("moveNote failed \(id) -> \(folder): \(error)")
            return id
        }
    }

    /// Create `folder` (and any missing parents) THEN move the note into it,
    /// ordered so the destination exists before the move. Used by the
    /// "New Folder…" path in the move sheet, where a fire-and-forget
    /// `createFolder` + separate `moveNote` could race. Returns the final id.
    @discardableResult
    func moveNoteCreatingFolder(_ id: String, folder: String) async -> String {
        do {
            _ = try await vault.createFolder(folder)
            let finalId = try await vault.moveNote(id, folder: folder)
            reload()
            search.noteRenamed(from: id, to: finalId)
            onLocalChange?()
            return finalId
        } catch {
            print("moveNoteCreatingFolder failed \(id) -> \(folder): \(error)")
            return id
        }
    }

    /// Delete a folder (MOVE-UP semantics — see `NoteVault.deleteFolder`).
    /// Notes inside move to the parent folder; nothing is lost. Many ids change
    /// at once, so the search index takes a full rescan instead of per-note
    /// notifies.
    func deleteFolder(_ folder: String) {
        Task {
            do {
                _ = try await vault.deleteFolder(folder)
                search.rescanAsync()
                onLocalChange?()
            } catch {
                print("deleteFolder failed for \(folder): \(error)")
            }
            reload()
        }
    }

    /// Create a folder (and any missing intermediate folders) on disk, then
    /// reload so it appears in the browser.
    func createFolder(_ path: String) {
        Task {
            do {
                _ = try await vault.createFolder(path)
                reload()
                onLocalChange?()
            } catch {
                print("createFolder failed for \(path): \(error)")
            }
        }
    }

    /// Count of notes at or beneath `folder` (for the delete confirmation).
    func noteCount(under folder: String) -> Int {
        notes.filter { $0.folder == folder || $0.folder.hasPrefix(folder + "/") }.count
    }

    /// Immediate child folder paths of `folder` ("" = root). Sorted.
    func subfolders(of folder: String) -> [String] {
        let prefix = folder.isEmpty ? "" : folder + "/"
        return folders.filter { path in
            guard path.hasPrefix(prefix) else { return false }
            let tail = String(path.dropFirst(prefix.count))
            // Immediate child: non-empty and no further "/".
            return !tail.isEmpty && !tail.contains("/")
        }
    }

    /// Notes whose parent folder is exactly `folder` ("" = root).
    func notes(in folder: String) -> [NoteItem] {
        notes.filter { $0.folder == folder }
    }

    // MARK: - Paths / maintenance

    /// Absolute filesystem path of a note's `.md` file (Copy File Path).
    func notePath(_ id: String) -> String {
        notesRoot.appendingPathComponent(id + ".md").path
    }

    /// A live pull rewrote the vault on disk: refresh the list AND rescan the
    /// search index (remote edits bypass the per-mutation notify* calls). Wired
    /// to `SyncManager.onLivePull` in FutoNotesApp.
    func liveDataChanged() {
        reload()
        search.rescanAsync()
    }

    /// Danger-zone full reset (Settings): delete EVERYTHING under the vault
    /// root — notes, folders, images, `.crashlogs` — then reload to empty.
    /// The caller (SettingsView) pauses live sync before and disconnects after,
    /// so the deletions are never pushed to peers. Runs off-main; does NOT
    /// re-seed (seeding is bootstrap-only).
    func fullReset() async {
        let root = notesRoot
        await Task.detached(priority: .userInitiated) {
            let fm = FileManager.default
            let entries = (try? fm.contentsOfDirectory(atPath: root.path)) ?? []
            for entry in entries {
                try? fm.removeItem(at: root.appendingPathComponent(entry))
            }
        }.value
        search.rescanAsync()
        reload()
    }
}

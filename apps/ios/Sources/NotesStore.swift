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
    func write(_ id: String, content: String) throws
        -> (preview: String, richPreview: String, tags: [String])
    {
        try core.write(id: id, content: content)
        return (
            makePreview(content: content),
            makeRichPreview(content: content),
            extractTags(content: content)
        )
    }

    /// Conditional write for a backgrounded editor flush (see
    /// `NotesStore.flushAsync`): write `content` only if the note still holds
    /// `base`. Returns the outcome plus, on a genuine write (`.wrote`), the fresh
    /// preview/tags for the in-place row refresh (nil otherwise). The
    /// anti-resurrection / anti-clobber decision lives in the Rust
    /// `write_note_if_unchanged` — this is a thin off-main wrapper.
    func writeIfUnchanged(_ id: String, base: String, content: String) throws
        -> (outcome: FlushOutcome, derived: (preview: String, richPreview: String, tags: [String])?)
    {
        let outcome = try core.writeIfUnchanged(id: id, expectedPrev: base, content: content)
        guard outcome == .wrote else { return (outcome, nil) }
        return (
            outcome,
            (makePreview(content: content), makeRichPreview(content: content),
                extractTags(content: content))
        )
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
        // Seed content lives in futo-notes-model (`seed_if_empty`) so iOS,
        // Android, and desktop share one user-facing first run that can't drift.
        _ = try? core.seedIfEmpty()
    }
}

/// An open editor's unsaved draft: the note `id` to persist, the `content` to
/// write, and `base` — the content the editor believes is on disk (its
/// `savedContent`). `base` is the expected-previous for the conditional flush
/// (see `NotesStore.flushAsync` → `writeIfUnchanged`): the flush writes only if
/// the note still holds `base`, so a note deleted or sync-adopted while
/// backgrounded is neither resurrected nor clobbered. Mirrors Android's
/// `PendingDraft` (NotesStore.kt).
struct PendingDraft: Equatable {
    let id: String
    let base: String
    let content: String
}

/// The open editor's unsaved-draft derivation — the ONE definition of "is there
/// an unsaved draft, for which note" (PKT-12 R5). Returns a draft keyed on the
/// LIVE `noteId` (so it re-keys by construction after a rename) whenever the body
/// has loaded and diverges from what's on disk; `nil` when clean or not yet
/// loaded. `savedContent` is both the dirty check and the flush's expected-prev
/// (`base`). Pure + top-level so it mirrors the Kotlin `derivePendingDraft`
/// exactly. SwiftUI `@State` can't be pulled from an escaping closure the way
/// Compose snapshot state can, so the editor PUSHES this derived value via
/// `.onChange` on every state change; the derivation stays the single source of
/// truth for "clean vs dirty" (no scattered set/clear sites, PKT-1 R1-R4).
func derivePendingDraft(loaded: Bool, noteId: String, savedContent: String, content: String)
    -> PendingDraft?
{
    (loaded && content != savedContent)
        ? PendingDraft(id: noteId, base: savedContent, content: content) : nil
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

    /// The open editors' unsaved-draft register (F8 jetsam guard). Each open
    /// editor claims a token and publishes its DERIVED draft (`derivePendingDraft`)
    /// under that token on every state change; the app's scenePhase handler calls
    /// `flushPendingEditor()` when leaving `.active`, flushing every live editor's
    /// draft so an edit caught inside the 400 ms autosave debounce is persisted
    /// before the OS can jetsam the app. Pushed down here so the scenePhase handler
    /// never reaches into editor internals. Mirrors Android's `PendingEditorDraft`.
    ///
    /// A MAP keyed by token, NOT a single slot: during a NavigationStack push/pop
    /// several editors briefly coexist (wikilink chains share one WebView), so a
    /// single slot would let the incoming editor's publish EVICT an outgoing dirty
    /// editor's draft — a background+kill in that window would then flush nothing
    /// and lose its edit (PKT-1 R2). Per-token entries never touch each other, so
    /// the eviction is impossible by construction; `releaseDraftOwnership` removes
    /// only the caller's own entry.
    private var draftSeq: UInt64 = 0
    private var draftRegister: [UInt64: PendingDraft] = [:]

    /// A newly-appeared editor claims a register entry; returns its unique token.
    /// Entries are keyed by it, so editors overlapping during a push/pop
    /// transition never evict each other's draft (PKT-1 R2).
    func claimDraftOwnership() -> UInt64 {
        draftSeq += 1
        return draftSeq
    }

    /// The editor publishes (or clears, with `nil`) its DERIVED draft under its
    /// own `token` — called reactively on every state change. Replaces the old
    /// hand-synced set/clear sites: the register reflects the derivation's verdict
    /// (`content != savedContent`) on demand, so a completed save / adopted remote
    /// clears the draft by construction (PKT-1 R1). Never touches another editor's
    /// entry.
    func publishDraft(token: UInt64, _ draft: PendingDraft?) {
        draftRegister[token] = draft
    }

    /// The editor left the screen — removes only its own entry, leaving any
    /// overlapping editor's draft intact.
    func releaseDraftOwnership(token: UInt64) {
        draftRegister[token] = nil
    }

    /// Flush every live editor's pending draft to disk (scenePhase inactive/
    /// background). Coalesces by note id, keeping the highest-token (most recently
    /// claimed = incoming/visible) draft, so two editors overlapping on the SAME
    /// note during a transition issue exactly one conditional write instead of two
    /// racing on the same base (Android parity: LinkedHashMap last-registered wins).
    /// No-op when every draft is clean / closed; safe at every leave-active signal.
    func flushPendingEditor() {
        guard !draftRegister.isEmpty else { return }
        var byId: [String: (token: UInt64, draft: PendingDraft)] = [:]
        for (token, draft) in draftRegister {
            if let existing = byId[draft.id], existing.token >= token { continue }
            byId[draft.id] = (token, draft)
        }
        for entry in byId.values { flushAsync(entry.draft) }
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
            richPreview: meta.richPreview,
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
            let (preview, richPreview, tags) = try await vault.write(id, content: content)
            applyWriteBookkeeping(id: id, preview: preview, richPreview: richPreview, tags: tags)
        } catch {
            print("write failed for \(id): \(error)")
        }
    }

    /// Reflect a write of `id` that already landed on disk into the in-memory
    /// list, search index, and auto-push signal — the post-write bookkeeping
    /// shared by `write` and `flushAsync`'s conditional write.
    ///
    /// Updates the in-memory note IN PLACE instead of a full rescan + resort:
    /// reassigning the whole `notes` array on every keystroke churns the List's
    /// diffing and pops the pushed editor out from under the user. In-place keeps
    /// row identity/order stable while refreshing the preview/tags. A note not in
    /// the list yet (structural create) triggers a rescan. Preview + tags come
    /// from the same Rust rules the scan uses.
    private func applyWriteBookkeeping(
        id: String, preview: String, richPreview: String, tags: [String]
    ) {
        if let idx = notes.firstIndex(where: { $0.id == id }) {
            let old = notes[idx]
            notes[idx] = NoteItem(
                id: old.id,
                title: old.title,
                folder: old.folder,
                modified: Date(),
                preview: preview,
                richPreview: richPreview,
                tags: tags
            )
        } else {
            reload()
        }
        search.noteChanged(id)
        onLocalChange?()
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

    /// Fire-and-forget conditional flush of a pending draft from a context that
    /// cannot `await` — `NoteEditorView.onDisappear` (pop) and the app's scenePhase
    /// background handler. A conditional write (`writeIfUnchanged`): persist
    /// `draft.content` only if the note still holds `draft.base` (the content the
    /// editor last saw). One FFI call replaces the old `exists()`-then-`write()`
    /// sequence, collapsing its cross-FFI TOCTOU — a note deleted while
    /// backgrounded returns `.skippedMissing` (never resurrected), and content a
    /// live-sync pull adopted since the editor's last read returns
    /// `.skippedChanged` (never clobbered). Only a genuine write (`.wrote`)
    /// reflects into the in-memory list. Mirrors Android's `NotesStore.flushAsync`.
    func flushAsync(_ draft: PendingDraft) {
        Task {
            do {
                let (outcome, derived) = try await vault.writeIfUnchanged(
                    draft.id, base: draft.base, content: draft.content)
                if outcome == .wrote, let derived {
                    applyWriteBookkeeping(
                        id: draft.id, preview: derived.preview,
                        richPreview: derived.richPreview, tags: derived.tags)
                }
            } catch {
                print("flush failed for \(draft.id): \(error)")
            }
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

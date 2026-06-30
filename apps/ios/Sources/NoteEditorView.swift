import SwiftUI
import UIKit

struct NoteEditorView: View {
    @EnvironmentObject private var store: NotesStore
    @Environment(\.colorScheme) private var colorScheme

    /// Current note id. Mutable because renaming changes the file path.
    @State private var noteId: String
    /// Drives the (inline) nav-bar title; updated on rename.
    @State private var titleField: String
    @State private var content: String
    /// The content last written to disk. We only persist when `content` differs
    /// from this, so opening + closing a note WITHOUT editing never rewrites the
    /// file (which would bump its modified date to "now").
    @State private var savedContent = ""
    @State private var saveTask: Task<Void, Never>?
    /// CRITICAL: never block the editor's first frame on a disk read (F9 / the
    /// never-gate-render rule). The body starts empty and is read OFF the main
    /// actor in `.task`; until it lands, `loaded` is false, which gates the
    /// live-sync adopt + the onChange save so an empty placeholder is never
    /// written back over the real note (data-loss guard). Mirrors Android's
    /// `loaded` flag in NoteEditorScreen.kt.
    @State private var loaded = false
    // Rename is presented from the nav-bar menu (the big title header is gone
    // so the editor can be full-screen).
    @State private var showRename = false
    @State private var renameField = ""
    /// Move sheet (nav-bar menu "Move to Folder…").
    @State private var showMove = false
    /// Destructive delete is always confirmed (list.md parity).
    @State private var showDeleteConfirm = false

    /// Path of the enclosing NavigationStack. A resolved-wikilink tap REPLACES
    /// the current editor entry (Back returns to the list, not a chain of
    /// editors); a delete pops it.
    @Binding var navPath: [Route]

    /// Auto-focus the editor (and raise the keyboard) on open — only for a
    /// brand-new note. Opening an existing note leaves the keyboard down until
    /// the user taps.
    let autoFocus: Bool

    init(noteId: String, autoFocus: Bool = false, navPath: Binding<[Route]>) {
        _noteId = State(initialValue: noteId)
        _titleField = State(initialValue: splitId(id: noteId).title)
        _content = State(initialValue: "")
        _navPath = navPath
        self.autoFocus = autoFocus
    }

    private var theme: String {
        colorScheme == .dark ? "dark" : "light"
    }

    var body: some View {
        // Full-screen editor: no native title header / tag bar / divider — the
        // note's heading and #tags already render inside the editor. Only the
        // standard (inline) nav bar remains for Back + the Rename menu.
        EditorWebView(
            content: content,
            theme: theme,
            autoFocus: autoFocus,
            onChange: { newContent in
                // Data-loss guard: ignore editor change events until the off-main
                // initial read has landed (`loaded`). The reused WebView mounts
                // with the new note's content via setContent and can emit an echo
                // before the disk read returns; saving that echo could clobber the
                // note on disk. Once loaded, all edits flow through.
                guard loaded else { return }
                content = newContent
                // Publish the live draft so the scenePhase background handler can
                // flush it before jetsam, even mid-debounce (F8).
                store.setPendingDraft(
                    newContent != savedContent ? (id: noteId, content: newContent) : nil)
                scheduleSave(newContent)
            },
            onOpenNote: { id in
                openLinkedNote(id)
            }
        )
        .ignoresSafeArea(.container, edges: .bottom)
        .background(Theme.background)
        .navigationTitle(titleField)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        renameField = splitId(id: noteId).title
                        showRename = true
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                    Button {
                        prepareMove()
                    } label: {
                        Label("Move to Folder…", systemImage: "folder")
                    }
                    Button {
                        UIPasteboard.general.string = store.notePath(noteId)
                    } label: {
                        Label("Copy File Path", systemImage: "doc.on.doc")
                    }
                    ShareLink(item: content) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                    Divider()
                    Button(role: .destructive) {
                        showDeleteConfirm = true
                    } label: {
                        Label("Delete Note", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .tint(Theme.primary)
            }
        }
        .alert("Rename note", isPresented: $showRename) {
            TextField("Title", text: $renameField)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { commitRename() }
        } message: {
            Text("Enter a new name for this note.")
        }
        .confirmationDialog(
            "Delete this note? This action cannot be undone.",
            isPresented: $showDeleteConfirm, titleVisibility: .visible
        ) {
            Button("Delete Note", role: .destructive) { deleteNote() }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(isPresented: $showMove) {
            // Keep the note open under its new id after the move (onMoved).
            MoveToFolderSheet(
                note: currentItem,
                currentFolder: splitId(id: noteId).folder,
                onMoved: { newId in
                    noteId = newId
                    titleField = splitId(id: newId).title
                }
            )
            .environmentObject(store)
        }
        .task {
            // Off-main initial load of the note body. Runs once; SwiftUI cancels
            // the task on disappear, and `loaded` guards re-entry on reappear so
            // a reloaded view never discards in-memory edits.
            guard !loaded else { return }
            let disk = await store.read(noteId)
            content = disk
            savedContent = disk
            loaded = true
        }
        .onReceive(store.$notes) { _ in
            // Keep the embed's note universe (wikilink resolution/autocomplete)
            // current. Independent of the open note's load state; deduped by
            // EditorHost on the JSON string. The initial subscription publish
            // covers the first push; EditorHost re-pushes on a fresh 'ready'.
            pushNotesUniverse()
            // Live-sync refresh for the OPEN note. A live pull rewrites the file
            // and reloads the store; without this, the open editor keeps showing
            // (and on exit, SAVES BACK) a stale base — silently clobbering the
            // remote edit. See adoptExternalChange for the clean/dirty rules.
            guard loaded else { return }
            Task { await adoptExternalChange() }
        }
        .onDisappear {
            // Stop providing a draft once this editor is gone, then flush a
            // pending save (only if changed). `flushAsync` re-checks existence
            // off-main so a note deleted while open is never resurrected, and
            // won't bump mtime on a no-edit open/close.
            saveTask?.cancel()
            store.setPendingDraft(nil)
            if content != savedContent {
                store.flushAsync(noteId, content: content)
                savedContent = content
            }
        }
    }

    private func scheduleSave(_ newContent: String) {
        saveTask?.cancel()
        saveTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 400_000_000) // 0.4s debounce
            if Task.isCancelled { return }
            // Re-read `noteId` at FIRE time (not schedule time) so a save that
            // lands after a rename writes to the renamed note, not the stale id.
            // This is the second half of the ghost-note fix (F7); the first half
            // is the flush+cancel in commitRename. Mirrors Android's
            // NoteEditorScreen.kt re-read at the debounce fire.
            await store.write(noteId, content: newContent)
            savedContent = newContent
        }
    }

    private func commitRename() {
        Task {
            let parts = splitId(id: noteId)
            let trimmed = renameField.trimmingCharacters(in: .whitespacesAndNewlines)
            // Reject empty (sanitizeTitle would coerce to "Untitled" and lose the
            // note's identity).
            guard !trimmed.isEmpty else { return }
            let sanitized = sanitizeTitle(title: trimmed)
            guard sanitized != parts.title else { return }

            // GHOST-NOTE FIX (F7): cancel the in-flight debounced save AND flush
            // any pending body edit to the CURRENT id before the file moves.
            // Without this, a stale save (which captured the OLD id) would run
            // after the rename and recreate a ghost note at the old path
            // (write_note creates files unconditionally) — data loss. Mirrors
            // Android's NoteEditorScreen.kt rename path.
            saveTask?.cancel()
            if content != savedContent {
                await store.write(noteId, content: content)
                savedContent = content
            }
            // The body is now flushed to the current id; the draft is clean.
            store.setPendingDraft(nil)

            let targetId = makeId(folder: parts.folder, title: sanitized)
            let finalId = await store.rename(oldId: noteId, newId: targetId)
            noteId = finalId
            titleField = splitId(id: finalId).title
        }
    }

    /// The open note's list item — for the move sheet. Falls back to a synthetic
    /// item when the store is mid-reload (the sheet only needs id/title/folder).
    private var currentItem: NoteItem {
        if let item = store.notes.first(where: { $0.id == noteId }) { return item }
        let parts = splitId(id: noteId)
        return NoteItem(
            id: noteId, title: parts.title, folder: parts.folder,
            modified: Date(), preview: "", richPreview: "", tags: [])
    }

    /// Adopt an on-disk change of the OPEN note (live pull / external rewrite).
    /// Clean draft → adopt through the selection-preserving applyExternalContent
    /// path (sync.md: a remote update must not reset the caret). Dirty draft →
    /// the draft is parked as a "<title> (conflict YYYY-MM-DD)" copy and the
    /// disk content adopted, so neither side is silently lost.
    private func adoptExternalChange() async {
        guard await store.exists(noteId) else { return }
        let disk = await store.read(noteId)
        // Branch on the CURRENT draft state — the user may have typed while the
        // read was in flight (we're back on the main actor here).
        if content == savedContent {
            // Clean draft: adopt silently, caret/scroll preserved.
            guard disk != savedContent else { return }
            EditorHost.shared.applyExternal(content: disk)
            content = disk
            savedContent = disk
        } else if disk == savedContent {
            // Disk unchanged (reload was about some other note) — draft wins.
        } else if disk == content {
            // Draft and remote converged on the same text — nothing to park.
            savedContent = disk
            store.setPendingDraft(nil)
        } else {
            // True three-way conflict: cancel the pending save (it would clobber
            // the remote edit), park the draft as a conflict copy, then adopt.
            saveTask?.cancel()
            store.setPendingDraft(nil)
            let draft = content
            let parts = splitId(id: noteId)
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            let conflictTitle = "\(parts.title) (conflict \(formatter.string(from: Date())))"
            if let conflictId = await store.createNote(
                title: conflictTitle, folder: parts.folder)
            {
                await store.write(conflictId, content: draft)
            }
            EditorHost.shared.applyExternal(content: disk)
            content = disk
            savedContent = disk
        }
    }

    /// Push the note universe ([{id,title,modifiedMs,tags}] JSON) into the
    /// embed for suffix resolution, autocomplete, and wikilink decoration. The
    /// built JSON doubles as the dedupe signature — EditorHost skips the
    /// evaluateJavaScript when it matches the last push.
    private func pushNotesUniverse() {
        let items: [[String: Any]] = store.notes.map { note in
            [
                "id": note.id,
                "title": note.title,
                "modifiedMs": Int64(note.modified.timeIntervalSince1970 * 1000),
                "tags": note.tags,
            ]
        }
        let data = (try? JSONSerialization.data(withJSONObject: items, options: [.sortedKeys]))
            ?? Data("[]".utf8)
        EditorHost.shared.setNotes(String(data: data, encoding: .utf8) ?? "[]")
    }

    /// Bridge 'openNote': the user tapped a RESOLVED wikilink. REPLACE the
    /// current editor entry in the nav path (not push) so Back returns to the
    /// list. The outgoing view's onDisappear flushes any pending draft to the
    /// old id before the new editor's first save can fire.
    private func openLinkedNote(_ id: String) {
        guard id != noteId else { return }
        if navPath.isEmpty {
            navPath.append(.note(id))
        } else {
            navPath[navPath.count - 1] = .note(id)
        }
    }

    /// Nav-bar "Move to Folder…": flush the pending body edit to the CURRENT id
    /// before the file can move (same ghost-note class as commitRename — a
    /// stale debounced save would recreate the old path), then open the sheet.
    private func prepareMove() {
        Task {
            saveTask?.cancel()
            if content != savedContent {
                await store.write(noteId, content: content)
                savedContent = content
            }
            store.setPendingDraft(nil)
            showMove = true
        }
    }

    /// Confirmed delete from the nav-bar menu: neutralize every pending-save
    /// path FIRST (a write after the delete would resurrect the file — the Rust
    /// write creates files unconditionally), then delete and pop the editor.
    private func deleteNote() {
        saveTask?.cancel()
        store.setPendingDraft(nil)
        // Mark the draft clean so onDisappear's flush is a no-op.
        savedContent = content
        store.delete(noteId)
        if !navPath.isEmpty { navPath.removeLast() }
    }
}

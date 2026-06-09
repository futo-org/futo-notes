import SwiftUI

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

    /// Auto-focus the editor (and raise the keyboard) on open — only for a
    /// brand-new note. Opening an existing note leaves the keyboard down until
    /// the user taps.
    let autoFocus: Bool

    init(noteId: String, autoFocus: Bool = false) {
        _noteId = State(initialValue: noteId)
        _titleField = State(initialValue: splitId(id: noteId).title)
        _content = State(initialValue: "")
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
            // Live-sync refresh for the OPEN note. A live pull rewrites the file
            // and reloads the store; without this, the open editor keeps showing
            // (and on exit, SAVES BACK) a stale base — silently clobbering the
            // remote edit. Adopt the on-disk content only when the local draft is
            // clean; a dirty draft still wins (same rule as desktop external-
            // change handling). The on-disk read runs off-main.
            guard loaded else { return }
            guard content == savedContent else { return } // unsaved edits win
            Task {
                guard await store.exists(noteId) else { return }
                let disk = await store.read(noteId)
                // Re-check the draft is still clean after the await — the user may
                // have typed while the read was in flight.
                guard content == savedContent else { return }
                if disk != savedContent {
                    content = disk
                    savedContent = disk
                }
            }
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
}

import SwiftUI

/// A navigation destination in the folder browser: either a folder to browse
/// into, or a note to open in the editor.
enum Route: Hashable {
    case folder(String)
    case note(String)
    /// A just-created note — opens with the editor focused + keyboard up.
    case newNote(String)
}

struct NoteListView: View {
    @EnvironmentObject private var store: NotesStore
    @EnvironmentObject private var sync: SyncManager
    @State private var search = ""
    @State private var navPath: [Route] = []
    @State private var showSync = false

    private var filtered: [NoteItem] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return store.notes }
        return store.notes.filter { note in
            note.title.lowercased().contains(q)
                || note.preview.lowercased().contains(q)
                || note.tags.contains { $0.lowercased().contains(q) }
        }
    }

    var body: some View {
        NavigationStack(path: $navPath) {
            Group {
                if !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    // Search bypasses the folder browser: a flat, cross-folder
                    // list of matching notes.
                    searchResults
                } else {
                    // Root folder browser.
                    FolderContentsView(folder: "", navPath: $navPath)
                }
            }
            .background(Theme.background)
            .navigationTitle("Notes")
            .searchable(text: $search, prompt: "Search notes")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showSync = true
                    } label: {
                        Image(systemName: sync.connected ? "checkmark.icloud" : "icloud")
                    }
                    .tint(Theme.primary)
                }
            }
            .sheet(isPresented: $showSync) {
                SyncView()
                    .environmentObject(sync)
                    .environmentObject(store)
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .folder(let path):
                    FolderContentsView(folder: path, navPath: $navPath)
                        .environmentObject(store)
                case .note(let id):
                    NoteEditorView(noteId: id, autoFocus: false)
                        .environmentObject(store)
                case .newNote(let id):
                    NoteEditorView(noteId: id, autoFocus: true)
                        .environmentObject(store)
                }
            }
        }
    }

    private var searchResults: some View {
        Group {
            if filtered.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 48))
                        .foregroundStyle(Theme.primary)
                    Text("No matches")
                        .font(.title3.bold())
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(filtered) { note in
                        NavigationLink(value: Route.note(note.id)) {
                            NoteRow(note: note, showFolder: true)
                        }
                        .listRowBackground(Theme.surface)
                    }
                    .onDelete(perform: deleteSearchRows)
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
            }
        }
    }

    private func deleteSearchRows(_ offsets: IndexSet) {
        let ids = offsets.map { filtered[$0].id }
        for id in ids { store.delete(id) }
    }
}

/// Lists the immediate subfolders and notes of a single folder. Recursive:
/// tapping a subfolder pushes another FolderContentsView via Route.folder.
struct FolderContentsView: View {
    @EnvironmentObject private var store: NotesStore
    /// The folder this view shows ("" = root).
    let folder: String
    @Binding var navPath: [Route]

    @State private var showingNewFolder = false
    @State private var newFolderName = ""
    @State private var showingNewNote = false
    @State private var newNoteTitle = "Untitled"

    /// Note being moved (drives the move sheet).
    @State private var moveTarget: NoteItem?

    /// Subfolder path pending deletion (drives the destructive confirmation).
    @State private var folderToDelete: String?

    private var subfolders: [String] { store.subfolders(of: folder) }
    private var notes: [NoteItem] { store.notes(in: folder) }

    private var title: String {
        folder.isEmpty ? "Notes" : (folder.split(separator: "/").last.map(String.init) ?? folder)
    }

    private var isEmpty: Bool { subfolders.isEmpty && notes.isEmpty }

    var body: some View {
        Group {
            if isEmpty {
                emptyState
            } else {
                list
            }
        }
        .background(Theme.background)
        .navigationTitle(title)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        newNoteTitle = "Untitled"
                        showingNewNote = true
                    } label: {
                        Label("New Note", systemImage: "square.and.pencil")
                    }
                    Button {
                        newFolderName = ""
                        showingNewFolder = true
                    } label: {
                        Label("New Folder", systemImage: "folder.badge.plus")
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .tint(Theme.primary)
            }
        }
        .alert("New Note", isPresented: $showingNewNote) {
            TextField("Title", text: $newNoteTitle)
            Button("Cancel", role: .cancel) {}
            Button("Create") { createNote() }
        } message: {
            Text("Create a note in \(folder.isEmpty ? "Notes" : title).")
        }
        .alert("New Folder", isPresented: $showingNewFolder) {
            TextField("Folder name", text: $newFolderName)
            Button("Cancel", role: .cancel) {}
            Button("Create") { createFolder() }
        } message: {
            Text("Create a folder in \(folder.isEmpty ? "Notes" : title).")
        }
        .sheet(item: $moveTarget) { note in
            MoveToFolderSheet(note: note, currentFolder: folder)
                .environmentObject(store)
        }
        .alert(
            "Delete Folder?",
            isPresented: Binding(
                get: { folderToDelete != nil },
                set: { if !$0 { folderToDelete = nil } }
            ),
            presenting: folderToDelete
        ) { path in
            Button("Delete", role: .destructive) { store.deleteFolder(path) }
            Button("Cancel", role: .cancel) {}
        } message: { path in
            let name = path.split(separator: "/").last.map(String.init) ?? path
            let n = store.noteCount(under: path)
            Text("“\(name)” and its \(n) note\(n == 1 ? "" : "s") will be permanently deleted. This can’t be undone.")
        }
    }

    private var list: some View {
        List {
            if !subfolders.isEmpty {
                Section {
                    ForEach(subfolders, id: \.self) { child in
                        NavigationLink(value: Route.folder(child)) {
                            Label {
                                Text(child.split(separator: "/").last.map(String.init) ?? child)
                                    .font(.headline)
                            } icon: {
                                Image(systemName: "folder.fill")
                                    .foregroundStyle(Theme.primary)
                            }
                        }
                        .listRowBackground(Theme.surface)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                folderToDelete = child
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                        .contextMenu {
                            Button(role: .destructive) {
                                folderToDelete = child
                            } label: {
                                Label("Delete Folder…", systemImage: "trash")
                            }
                        }
                    }
                }
            }
            if !notes.isEmpty {
                Section {
                    ForEach(notes) { note in
                        NavigationLink(value: Route.note(note.id)) {
                            NoteRow(note: note, showFolder: false)
                        }
                        .listRowBackground(Theme.surface)
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                store.delete(note.id)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            Button {
                                moveTarget = note
                            } label: {
                                Label("Move", systemImage: "folder")
                            }
                            .tint(Theme.primary)
                        }
                        .contextMenu {
                            Button {
                                moveTarget = note
                            } label: {
                                Label("Move to Folder…", systemImage: "folder")
                            }
                            Button(role: .destructive) {
                                store.delete(note.id)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: folder.isEmpty ? "note.text" : "folder")
                .font(.system(size: 56))
                .foregroundStyle(Theme.primary)
            Text(folder.isEmpty ? "No notes yet" : "Empty folder")
                .font(.title2.bold())
            Text("Tap + to add a note or folder.")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func createNote() {
        Task {
            if let id = await store.createNote(title: newNoteTitle, folder: folder) {
                // .newNote → editor opens focused with the keyboard up.
                navPath.append(.newNote(id))
            }
        }
    }

    private func createFolder() {
        let name = newFolderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        store.createFolder(folder.isEmpty ? name : folder + "/" + name)
    }
}

/// Sheet for moving a note to a destination folder. Lists Root, every existing
/// folder, and a "New Folder…" option that creates a folder (under the note's
/// current folder) and moves the note into it.
struct MoveToFolderSheet: View {
    @EnvironmentObject private var store: NotesStore
    @Environment(\.dismiss) private var dismiss

    let note: NoteItem
    /// Folder currently being browsed — used as the parent for a brand-new
    /// folder created from this sheet.
    let currentFolder: String

    @State private var showingNewFolder = false
    @State private var newFolderName = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        move(to: "")
                    } label: {
                        rowLabel(text: "Root", system: "house.fill",
                                 isCurrent: note.folder.isEmpty)
                    }
                }
                if !store.folders.isEmpty {
                    Section("Folders") {
                        ForEach(store.folders, id: \.self) { path in
                            Button {
                                move(to: path)
                            } label: {
                                rowLabel(text: path, system: "folder.fill",
                                         isCurrent: note.folder == path)
                            }
                        }
                    }
                }
                Section {
                    Button {
                        newFolderName = ""
                        showingNewFolder = true
                    } label: {
                        Label("New Folder…", systemImage: "folder.badge.plus")
                            .foregroundStyle(Theme.primary)
                    }
                }
            }
            .navigationTitle("Move \"\(note.title)\"")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .tint(Theme.primary)
                }
            }
            .alert("New Folder", isPresented: $showingNewFolder) {
                TextField("Folder name", text: $newFolderName)
                Button("Cancel", role: .cancel) {}
                Button("Create & Move") { createAndMove() }
            } message: {
                Text("Create a folder\(currentFolder.isEmpty ? "" : " in \(currentFolder)") and move the note into it.")
            }
        }
    }

    @ViewBuilder
    private func rowLabel(text: String, system: String, isCurrent: Bool) -> some View {
        HStack {
            Label {
                Text(text).foregroundStyle(.primary)
            } icon: {
                Image(systemName: system).foregroundStyle(Theme.primary)
            }
            Spacer()
            if isCurrent {
                Image(systemName: "checkmark")
                    .foregroundStyle(Theme.primary)
            }
        }
    }

    private func move(to folder: String) {
        Task { await store.moveNote(note.id, toFolder: folder) }
        dismiss()
    }

    private func createAndMove() {
        let name = newFolderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let dest = currentFolder.isEmpty ? name : currentFolder + "/" + name
        // Create the folder then move into it — ordered so the destination
        // exists before the move. createFolder is fire-and-forget (Task-wrapped
        // internally); the move must observe its result, so chain explicitly.
        Task {
            _ = await store.moveNoteCreatingFolder(note.id, folder: dest)
        }
        dismiss()
    }
}

struct NoteRow: View {
    let note: NoteItem
    /// Whether to show the folder label (true in flat search results).
    var showFolder: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(note.title)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Text(note.modified, format: .relative(presentation: .named))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if showFolder && !note.folder.isEmpty {
                Label(note.folder, systemImage: "folder")
                    .font(.caption2)
                    .foregroundStyle(Theme.primary)
            }
            if !note.preview.isEmpty {
                Text(note.preview)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 2)
    }
}

import Foundation

extension NotesStore {
    /// Attach the Rust editor session to one read of a note, the read its first screens came
    /// from (blocking file I/O on the vault actor).
    func openEditorSession(_ read: EditorNoteRead) async throws -> NativeEditorSession {
        try await vault.openEditor(read)
    }

    /// Read a note once for its editor (off the vault actor).
    func readForEditor(_ id: String) async throws -> EditorNoteRead {
        let vault = vault
        return try await Task.detached(priority: .userInitiated) { try vault.readForEditor(id) }
            .value
    }

    /// The first screens of a long note, parsed from its first bytes alone; nil for a short note.
    func quickOpenView(_ read: EditorNoteRead) async -> EditorQuickView? {
        let vault = vault
        return await Task.detached(priority: .userInitiated) { vault.quickOpenView(read) }.value
    }

    /// A save the editor session made on its own: project it like any other mutation.
    func applyEditorMutation(_ mutation: NoteMutation) {
        applyMutation(mutation, expectedEpoch: resetEpoch)
        onLocalChange?()
    }
}

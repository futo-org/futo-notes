import Foundation

extension NotesStore {
    /// Attach the Rust editor session to a note (blocking file I/O on the vault actor).
    func openEditorSession(_ id: String) async throws -> NativeEditorSession {
        try await vault.openEditor(id)
    }

    /// The first screens of a long note, parsed from its first bytes alone; nil for a short note.
    func quickOpenView(_ id: String) async -> EditorQuickView? {
        let vault = vault
        return await Task.detached(priority: .userInitiated) { vault.quickOpenView(id) }.value
    }

    /// A save the editor session made on its own: project it like any other mutation.
    func applyEditorMutation(_ mutation: NoteMutation) {
        applyMutation(mutation, expectedEpoch: resetEpoch)
        onLocalChange?()
    }
}

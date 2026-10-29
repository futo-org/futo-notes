import Foundation

struct FixtureProjection: Sendable {
    let source: String
    let display: String

    static func open(workspace: CaptureWorkspace) async throws -> Self {
        try await Task.detached {
            let source = "__ab__ &amp; cd\r\n"
            let store = NoteStore(notesRoot: workspace.vault.path)
            _ = try store.createNote(title: "fixture", folder: "", content: source)
            let session = try store.openEditor(id: "fixture")
            let display = try session.displayText()
            try session.detach()
            return Self(source: source, display: display)
        }.value
    }
}

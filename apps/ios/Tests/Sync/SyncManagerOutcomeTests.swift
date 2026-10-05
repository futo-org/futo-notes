import Testing

@testable import FutoNotesNative

@Suite("Sync file failure copy")
@MainActor
struct SyncManagerOutcomeTests {
    @Test("HTTP 413 names the rejected upload")
    func oversizedUpload() {
        let message = SyncManager.specificFileFailure([
            SyncFailure(filename: "photos/large.png", kind: "upload", statusCode: 413)
        ])
        #expect(message?.path == "sync.errors.uploadsTooLarge")
        #expect(message?.arguments["filenames"] as? String == "photos/large.png")
    }

    @Test("unsupported path names the file")
    func unsupportedPath() {
        let message = SyncManager.specificFileFailure([
            SyncFailure(filename: "deep/note.md", kind: "rejected", statusCode: nil)
        ])
        #expect(message?.path == "sync.errors.unsupportedPaths")
        #expect(message?.arguments["filenames"] as? String == "deep/note.md")
    }
}

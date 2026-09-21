import Testing

@testable import FutoNotesNative

/// What an exit commits when the editor could not hand back its document —
/// i.e. whether the user can leave the screen at all.
///
/// 2026-09-01: opening a 50,000-line note with no blank line anywhere blocked
/// the editor's JS thread for minutes. The body stayed blank, and because the
/// shell treated "could not read the editor" as "refuse the exit", every Back
/// tap answered "Couldn't read the latest note. Navigation is paused while your
/// changes remain pending." — forever. Force-quit and Delete Note were the only
/// ways out. The rule below is Android's `EditorSession.exitWithoutEditor`
/// stated for iOS (docs/spec/editor.md, "Editor exits").
@Suite("Editor exit body")
struct EditorExitBodyTests {
    @Test("a captured document is the body, whatever the shell was holding")
    func capturedWins() {
        #expect(editorExitBody(.captured("live"), shellCopy: "stale") == "live")
    }

    @Test("an empty capture is a real answer, not a missing one")
    func emptyCaptureIsAnAnswer() {
        // A note whose body the user just cleared. Falling back to the shell's
        // copy here would resurrect the deleted text on the next save.
        #expect(editorExitBody(.captured(""), shellCopy: "old text") == "")
    }

    @Test("no live document leaves with the shell's own copy, so the user is never trapped")
    func noLiveDocumentLeaves() {
        // The editor never presented a document, so it cannot be holding an
        // edit; the shell's copy is the freshest body in existence.
        #expect(editorExitBody(.noLiveDocument, shellCopy: "from disk") == "from disk")
    }

    @Test("no live document and an unread note commits nothing — the load is abandoned")
    func noLiveDocumentAbandonsTheLoad() {
        // The shape of the reported bug: the note never opened, so the shell's
        // copy still equals what is on disk. The exit's own `!= savedContent`
        // guard turns this into a no-op write, which is exactly "abandon the
        // load rather than save a prefix".
        let onDisk = "the whole 50,000-line note"
        #expect(editorExitBody(.noLiveDocument, shellCopy: onDisk) == onDisk)
    }

    @Test("a capture belonging to another note refuses the exit")
    func notOursRefuses() {
        // The one genuinely ambiguous case, and the only one that still reports
        // a capture failure: reading would answer for the wrong document.
        #expect(editorExitBody(.notOurs, shellCopy: "ours") == nil)
    }
}

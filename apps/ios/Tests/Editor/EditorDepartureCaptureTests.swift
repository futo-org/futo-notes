import Foundation
import Testing

@testable import FutoNotesNative

/// Which note a `change` belongs to across a system pop, and what the popped
/// note's exit commits.
///
/// A system pop (Back button, edge swipe) from a note opened through a wikilink
/// re-inserts the linking note's view FIRST: its adopt rebinds the shared
/// WebView's callbacks and pushes the linking note before the popped editor's
/// exit runs. A `change` carries no note identity, so one that the popped note
/// posted — its last keystrokes, or the whole body of a large note edited while
/// it was still streaming — reached the linking note's callbacks and was saved
/// over the linking note's file, while the popped note's exit could only commit
/// a copy without the edit (RC-04, RC-09; 2026-09-28, iOS 27 simulator). The
/// adopt now reads the outgoing document before its push
/// (`EditorHost.captureDepartingDocument`), and this is that read.
@Suite("Editor departure capture")
@MainActor
struct EditorDepartureCaptureTests {
    @Test("a change that arrives while the outgoing note's read is pending is held back")
    func holdsChangesUntilTheReadAnswers() {
        let departure = EditorDepartureCapture(owner: 7)
        #expect(departure.holdsChanges)

        departure.resolve(.captured("Child note body plus typed words\n"))

        // From here on every change comes from the note pushed after the read.
        #expect(!departure.holdsChanges)

        // A page that died never answers; the reload must not stay fenced.
        let dead = EditorDepartureCapture(owner: 8)
        dead.resolve(.noLiveDocument)
        #expect(!dead.holdsChanges)
    }

    @Test("the popped note's exit gets the read, whether it asks before or after the answer")
    func exitReceivesTheRead() {
        let departure = EditorDepartureCapture(owner: 7)
        var early: EditorCaptureOutcome?
        departure.whenResolved { early = $0 }

        departure.resolve(.captured("EDITED Section 0"))
        var late: EditorCaptureOutcome?
        departure.whenResolved { late = $0 }

        #expect(early == .captured("EDITED Section 0"))
        #expect(late == .captured("EDITED Section 0"))
        #expect(
            editorLeaveBody(early ?? .notOurs, shellCopy: "Section 0") == "EDITED Section 0")
    }

    @Test("only the page's first answer counts")
    func firstAnswerWins() {
        let departure = EditorDepartureCapture(owner: 7)
        departure.resolve(.captured("the note"))
        departure.resolve(.noLiveDocument)
        #expect(departure.outcome == .captured("the note"))
    }

    @Test("a read still finishing a large note times out, and the exit's retry gets it")
    func slowReadIsRetried() async {
        // The read makes a streaming, edited note finish its load first, which
        // on a big enough note outlasts one deadline. `.timedOut` is what makes
        // the pop's exit ask again rather than commit the stale copy.
        let departure = EditorDepartureCapture(owner: 7)
        let first = await captureWithinDeadline(
            deadlineSeconds: 0.02,
            startLivenessProbe: {},
            rendererAnswered: { true },
            start: { answer in departure.whenResolved(answer) }
        )
        #expect(first == .timedOut)

        departure.resolve(.captured("the whole note plus the edit"))
        let retry = await captureWithinDeadline(
            deadlineSeconds: 5,
            startLivenessProbe: {},
            rendererAnswered: { true },
            start: { answer in departure.whenResolved(answer) }
        )
        #expect(retry == .captured("the whole note plus the edit"))
    }
}

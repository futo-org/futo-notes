import Foundation
import Testing

@testable import FutoNotesNative

/// What running out of time MEANS, and why one answer could not carry both cases.
///
/// The Milkdown editor mounts a large note's FIRST CHUNK synchronously and
/// streams the rest in idle slices, so `initialized` — and with it the shell's
/// `isReady` — arrives while the tail is still landing. The user can type into
/// that first viewport, and while the load is in flight the editor deliberately
/// withholds its `change` notification (a streaming document is a PREFIX of the
/// note, so reporting it would save a truncated file). The shell's own copy
/// therefore does NOT contain that edit. A capture in that window asks for the
/// whole document, which makes the editor finish the remaining parse
/// synchronously; on a big enough note that costs more than the deadline, and
/// reading the deadline as `.noLiveDocument` let the exit leave on the stale
/// copy and the edit was gone.
///
/// The deadline could not simply start refusing instead. It was added for a
/// 50,000-line single paragraph whose parse blocks the JS thread for MINUTES
/// (commit 57cc910a), and `isReady` does not protect that case: it is
/// app-lifetime state on the shared WebView, set on the first `initialized` and
/// cleared only when the WebContent process dies, so it is already true when the
/// next note's `setContent` wedges the thread. Refusing there is the trap that
/// commit fixed — every Back tap a toast, force-quit the only way off the screen.
///
/// So the two are told apart by a trivial round trip dispatched BEFORE the
/// capture: a streaming editor answers it between idle slices, a wedged one
/// never runs it.
@Suite("Editor capture deadline")
@MainActor
struct EditorCaptureDeadlineTests {
    @Test("an answer inside the deadline is the answer")
    func replyWins() async {
        let outcome = await captureWithinDeadline(
            deadlineSeconds: 5,
            startLivenessProbe: {},
            rendererAnswered: { false },
            start: { answer in answer(.captured("live")) }
        )
        #expect(outcome == .captured("live"))
    }

    @Test("a busy but answering renderer times out instead of claiming no document")
    func busyRendererTimesOut() async {
        // The editor is finishing the streamed tail, so nothing ever calls back
        // — but the renderer is turning over and the probe came back.
        let outcome = await captureWithinDeadline(
            deadlineSeconds: 0.02,
            startLivenessProbe: {},
            rendererAnswered: { true },
            start: { _ in }
        )
        #expect(outcome == .timedOut)
    }

    @Test("a wedged renderer is still .noLiveDocument, so the user can leave")
    func wedgedRendererStillLeaves() async {
        // The 50,000-line single paragraph: one long synchronous parse, so
        // neither the capture nor the probe ever runs.
        let outcome = await captureWithinDeadline(
            deadlineSeconds: 0.02,
            startLivenessProbe: {},
            rendererAnswered: { false },
            start: { _ in }
        )
        #expect(outcome == .noLiveDocument)
    }

    @Test("a reply that lands after the deadline is discarded, not applied twice")
    func lateReplyIsDropped() async {
        let outcome = await captureWithinDeadline(
            deadlineSeconds: 0.02,
            startLivenessProbe: {},
            rendererAnswered: { true },
            start: { answer in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    answer(.captured("the note plus the edit"))
                }
            }
        )
        #expect(outcome == .timedOut)
    }

    @Test("the liveness probe is dispatched before the capture starts")
    func probeIsDispatchedFirst() async {
        // The ordering IS the mechanism: behind the capture in the WebContent
        // process's task queue, the probe would wait on the very parse it is
        // meant to report around, and every timeout would read as a wedge again.
        var probed = false
        var probedBeforeCapture = false
        _ = await captureWithinDeadline(
            deadlineSeconds: 5,
            startLivenessProbe: { probed = true },
            rendererAnswered: { false },
            start: { answer in
                probedBeforeCapture = probed
                answer(.captured("live"))
            }
        )
        #expect(probedBeforeCapture)
    }

    @Test("a timed-out capture refuses the exit instead of committing the stale copy")
    func timedOutRefusesTheExit() {
        // The user typed into the first viewport while the tail streamed, so the
        // shell never saw the edit. Leaving on `shellCopy` discards it.
        #expect(editorExitBody(.timedOut, shellCopy: "the note as opened") == nil)
    }

    @Test("an editor that never presented a document still lets the user leave")
    func noLiveDocumentStillLeaves() {
        #expect(editorExitBody(.noLiveDocument, shellCopy: "from disk") == "from disk")
    }
}

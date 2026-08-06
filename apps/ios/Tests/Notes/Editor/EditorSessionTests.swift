import Testing

@testable import FutoNotesNative

/// The editor session's contract is an ORDER, so these tests inject recording
/// effects and assert the sequence the session drives them in. They replace the
/// per-predicate table tests that used to stand in for the ordering
/// (`editorChangeDisposition`, `shouldFlushEditorOnDisappear`,
/// `shouldHandleEditorDisappear`, `needsEditorCommitBeforeNavigation`,
/// `shouldCompleteEditorNavigation`, `editorDeleteContent`) — each of those was
/// a one-line predicate whose real behaviour only appeared once it was composed
/// with the others.
@Suite("Editor session")
@MainActor
struct EditorSessionTests {
    /// A one-shot signal both sides of a test can await. Main-actor only, so the
    /// ordering under test is deterministic rather than timing-dependent.
    @MainActor
    final class Signal {
        private var waiters: [CheckedContinuation<Void, Never>] = []
        private var isSet = false

        func set() {
            isSet = true
            let pending = waiters
            waiters = []
            for continuation in pending { continuation.resume() }
        }

        func wait() async {
            if isSet { return }
            await withCheckedContinuation { continuation in
                if isSet {
                    continuation.resume()
                } else {
                    waiters.append(continuation)
                }
            }
        }
    }

    @MainActor
    final class Recorder {
        var events: [String] = []
        var failure: EditorExitFailure?
        var lateContent: String?
        var attemptedBody: String?
        var succeeded = false

        func append(_ event: String) { events.append(event) }
    }

    /// Effects that record every call. `body` supplies the capture result, and
    /// the three commit steps report success or failure.
    private func effects(
        _ recorder: Recorder,
        name: String = "exit",
        body: @escaping @MainActor () async -> String? = { "body" },
        bodyCommits: Bool = true,
        titleCommits: Bool = true,
        performs: @escaping @MainActor () async -> Bool = { true }
    ) -> EditorExitEffects {
        EditorExitEffects(
            prepare: { recorder.append("\(name):prepare") },
            captureBody: {
                recorder.append("\(name):captureBody")
                return await body()
            },
            commitBody: { _ in
                recorder.append("\(name):commitBody")
                return bodyCommits
            },
            commitTitle: {
                recorder.append("\(name):commitTitle")
                return titleCommits
            },
            perform: { _ in
                recorder.append("\(name):perform")
                return await performs()
            },
            onSucceeded: {
                recorder.succeeded = true
                recorder.append("\(name):onSucceeded")
            },
            onFailed: { failure, late, attempted in
                recorder.failure = failure
                recorder.lateContent = late
                recorder.attemptedBody = attempted
                recorder.append("\(name):onFailed")
            }
        )
    }

    @Test("cancel-and-drain waits for an admitted save to settle")
    func cancelAndDrainWaitsForSave() async {
        let session = EditorSession()
        let recorder = Recorder()
        let started = Signal()
        let release = Signal()

        session.schedule(.save) {
            started.set()
            await release.wait()
            recorder.append("save settled")
            return true
        }
        await started.wait()

        let drain = Task { @MainActor in
            await session.cancelAndDrain(.save)
            recorder.append("drain returned")
        }
        await Task.yield()
        #expect(recorder.events.isEmpty)

        release.set()
        await drain.value

        #expect(recorder.events == ["save settled", "drain returned"])
    }

    @Test("delete latches the session closed before it suspends")
    func deleteLatchesSynchronously() async {
        let session = EditorSession()
        let recorder = Recorder()
        let started = Signal()
        let release = Signal()

        session.schedule(.adopt) {
            started.set()
            await release.wait()
            return true
        }
        await started.wait()

        let exit = session.end(.delete, effects: effects(recorder, name: "delete"))

        // Latched in the window between the confirm tap and the drain running:
        // a bridge change arriving now is held aside, not applied.
        #expect(session.isClosing)
        #expect(session.disposition(loaded: true) == .quarantine)
        #expect(!session.shouldFlushOnLeave(loaded: true, content: "a", savedContent: "b"))

        release.set()
        _ = await exit?.value
    }

    @Test("delete drains every in-flight workflow before it commits")
    func deleteDrainsBeforeCommitting() async {
        let session = EditorSession()
        let recorder = Recorder()
        let started = Signal()
        let release = Signal()

        session.schedule(.adopt) {
            started.set()
            await release.wait()
            recorder.append("adopt")
            return true
        }
        await started.wait()

        let exit = session.end(.delete, effects: effects(recorder, name: "delete"))
        release.set()
        _ = await exit?.value

        #expect(
            recorder.events == [
                "delete:prepare",
                "adopt",
                "delete:captureBody",
                "delete:commitBody",
                "delete:perform",
                "delete:onSucceeded",
            ]
        )
    }

    @Test("a workflow scheduled after the session closes never touches the note")
    func closedSessionDropsLateWork() async {
        let session = EditorSession()
        let recorder = Recorder()

        let exit = session.end(.delete, effects: effects(recorder, name: "delete"))
        let late = session.schedule(.save) {
            recorder.append("late save")
            return true
        }
        _ = await exit?.value
        _ = await late.value

        #expect(!recorder.events.contains("late save"))
    }

    @Test("delete folds a change that lands mid-exit into the commit")
    func deleteCommitsLateQuarantinedChange() async {
        let session = EditorSession()
        let recorder = Recorder()
        var committed: [String] = []
        var quarantines = 0

        let exit = session.end(
            .delete,
            effects: EditorExitEffects(
                captureBody: { "captured" },
                commitBody: { body in
                    committed.append(body)
                    // A bridge change delivered while the first write was in
                    // flight: it is newer than what we just wrote, so the
                    // session must write it too before deleting.
                    if quarantines == 0 {
                        quarantines += 1
                        session.quarantine("later keystroke")
                    }
                    return true
                },
                perform: { body in
                    committed.append("perform:\(body ?? "nil")")
                    return true
                },
                onSucceeded: { recorder.append("succeeded") }
            )
        )
        _ = await exit?.value

        #expect(committed == ["captured", "later keystroke", "perform:later keystroke"])
        #expect(recorder.events == ["succeeded"])
    }

    @Test("a failed delete unlatches so the editor stays usable")
    func failedDeleteUnlatches() async {
        let session = EditorSession()
        let recorder = Recorder()

        let exit = session.end(
            .delete,
            effects: effects(recorder, name: "delete", performs: { false })
        )
        _ = await exit?.value

        #expect(recorder.failure == .action)
        #expect(!session.isClosing)
        #expect(session.disposition(loaded: true) == .apply)
    }

    @Test("a delete whose draft write fails never deletes")
    func failedDeleteWriteStopsShort() async {
        let session = EditorSession()
        let recorder = Recorder()

        let exit = session.end(
            .delete,
            effects: effects(recorder, name: "delete", bodyCommits: false)
        )
        _ = await exit?.value

        #expect(recorder.failure == .body)
        #expect(recorder.attemptedBody == "body")
        #expect(!recorder.events.contains("delete:perform"))
        #expect(!session.isClosing)
    }

    @Test("navigation commits the title before the body, then leaves")
    func navigationCommitOrder() async {
        let session = EditorSession()
        let recorder = Recorder()

        // A rename that has not committed yet is what makes the session retry
        // the title before touching the body.
        session.schedule(.rename) { false }

        let exit = session.end(.navigate, effects: effects(recorder, name: "nav"))
        _ = await exit?.value

        #expect(
            recorder.events == [
                "nav:prepare",
                "nav:commitTitle",
                "nav:captureBody",
                "nav:commitBody",
                "nav:perform",
                "nav:onSucceeded",
            ]
        )
    }

    @Test("navigation skips the title retry when the rename already committed")
    func navigationSkipsSettledTitle() async {
        let session = EditorSession()
        let recorder = Recorder()

        session.schedule(.rename) { true }

        let exit = session.end(.navigate, effects: effects(recorder, name: "nav"))
        _ = await exit?.value

        #expect(!recorder.events.contains("nav:commitTitle"))
        #expect(recorder.succeeded)
    }

    @Test("navigation refuses to leave while a rename cannot commit")
    func navigationBlockedByPendingRename() async {
        let session = EditorSession()
        let recorder = Recorder()

        session.schedule(.rename) { false }

        let exit = session.end(
            .navigate,
            effects: effects(recorder, name: "nav", titleCommits: false)
        )
        _ = await exit?.value

        #expect(recorder.failure == .title)
        #expect(!recorder.events.contains("nav:captureBody"))
    }

    @Test("navigation stops when the editor cannot hand back its body")
    func navigationStopsOnCaptureFailure() async {
        let session = EditorSession()
        let recorder = Recorder()

        let exit = session.end(
            .navigate,
            effects: effects(recorder, name: "nav", body: { nil })
        )
        _ = await exit?.value

        #expect(recorder.failure == .capture)
        #expect(!recorder.events.contains("nav:commitBody"))
    }

    @Test("only one exit at a time, and a refused one may be retried")
    func navigationAdmitsOneExit() async {
        let session = EditorSession()
        let first = Recorder()
        let second = Recorder()
        let started = Signal()
        let release = Signal()
        var locks: [Bool] = []
        session.onInteractionLockChanged = { locks.append($0) }

        session.schedule(.adopt) {
            started.set()
            await release.wait()
            return true
        }
        await started.wait()

        let exit = session.end(
            .navigate,
            effects: effects(first, name: "first", bodyCommits: false)
        )
        // A second Back while the first exit is draining is dropped entirely.
        #expect(session.end(.navigate, effects: effects(second, name: "second")) == nil)

        release.set()
        _ = await exit?.value

        #expect(second.events.isEmpty)
        #expect(first.failure == .body)
        #expect(locks == [true, false])

        // The failed exit released the lock, so Back works again.
        let retry = Recorder()
        _ = await session.end(.navigate, effects: effects(retry, name: "retry"))?.value
        #expect(retry.succeeded)
    }

    @Test("a move registers as the move workflow, so a delete drains it")
    func deleteDrainsAnInFlightMove() async {
        let session = EditorSession()
        let recorder = Recorder()
        let started = Signal()
        let release = Signal()

        session.end(
            .move,
            effects: EditorExitEffects(
                captureBody: {
                    started.set()
                    await release.wait()
                    recorder.append("move:captureBody")
                    return "body"
                },
                perform: { _ in
                    recorder.append("move:perform")
                    return true
                }
            )
        )
        await started.wait()

        let delete = session.end(.delete, effects: effects(recorder, name: "delete"))
        release.set()
        _ = await delete?.value

        // The delete may not touch the note until the move it found in flight
        // has finished — otherwise it would delete the pre-move id.
        let movePerform = recorder.events.firstIndex(of: "move:perform") ?? -1
        let deleteCommit = recorder.events.firstIndex(of: "delete:commitBody") ?? -1
        #expect(movePerform >= 0)
        #expect(deleteCommit >= 0)
        #expect(movePerform < deleteCommit)
    }

    @Test("presenting the move picker drains without committing anything")
    func prepareMoveOnlyDrains() async {
        let session = EditorSession()
        let recorder = Recorder()

        let exit = session.end(.prepareMove, effects: effects(recorder, name: "picker"))
        _ = await exit?.value

        #expect(recorder.events == ["picker:prepare", "picker:perform", "picker:onSucceeded"])
    }

    @Test("editor changes are ignored before load and quarantined once closing")
    func editorChangeDisposition() async {
        let session = EditorSession()
        let recorder = Recorder()

        #expect(session.disposition(loaded: false) == .ignore)
        #expect(session.disposition(loaded: true) == .apply)

        let exit = session.end(.delete, effects: effects(recorder, name: "delete"))
        #expect(session.disposition(loaded: true) == .quarantine)
        _ = await exit?.value
    }

    @Test("a peer delete closes the session without draining or committing")
    func externalDeleteCloses() async {
        let session = EditorSession()
        let recorder = Recorder()

        let save = session.schedule(.save) {
            recorder.append("save")
            return true
        }
        session.closeForExternalDelete()
        _ = await save.value

        #expect(session.isClosing)
        #expect(recorder.events.isEmpty)
        #expect(!session.shouldFlushOnLeave(loaded: true, content: "a", savedContent: "b"))
    }

    @Test("a loaded, dirty, open editor still flushes on leave")
    func leaveFlushesDirtyEditor() {
        let session = EditorSession()

        #expect(session.shouldFlushOnLeave(loaded: true, content: "edit", savedContent: "base"))
        #expect(!session.shouldFlushOnLeave(loaded: false, content: "edit", savedContent: ""))
        #expect(!session.shouldFlushOnLeave(loaded: true, content: "same", savedContent: "same"))
    }
}

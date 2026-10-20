import Testing

@testable import FutoNotesNative

extension OpenNoteReconcilerTests {
    @Test("a superseded reconciliation cannot apply after its read")
    func cancellationDropsVerdict() async {
        let editor = FakeEditor()
        let signal = Signal()
        var effects = editor.effects()
        effects.readDisk = { _ in
            await signal.wait()
            return "peer"
        }
        let reconciler = OpenNoteReconciler(classify: { _ in .adopt(content: "peer") })

        let task = Task { @MainActor in
            await reconciler.reconcile(change: .external, effects: effects)
        }
        while !signal.isWaiting { await Task.yield() }
        task.cancel()
        signal.release()

        #expect(await task.value == .stale)
        #expect(!editor.events.contains("adopt:peer"))
        // The pass had cancelled the debounced save; a cancelled pass re-arms
        // it (an exit that stops short, or a dismissed move picker, cancel
        // .adopt mid-pass).
        #expect(editor.events.last == "resume-save")
    }

    @Test("typing during the disk read reaches the classifier")
    func readUsesCurrentDraftAndEditVersion() async {
        let editor = FakeEditor()
        editor.disk = "peer"
        editor.mutateWhileReading = {
            editor.snapshot.draft = "mine"
            editor.snapshot.editVersion += 1
        }
        var factsSeen: OpenNoteReconcileFacts?
        let reconciler = OpenNoteReconciler { facts in
            factsSeen = facts
            return .keepDraft(base: facts.disk ?? "", reason: .diverged)
        }

        let result = await reconciler.reconcile(
            change: .external,
            effects: editor.effects()
        )

        #expect(result == .applied)
        #expect(factsSeen?.draft == "mine")
        #expect(factsSeen?.editedDuringCycle == true)
        #expect(editor.events.last == "keep:peer:diverged")
    }

    @Test("a hidden editor defers effects until it becomes visible")
    func hiddenEditorDefers() async {
        let editor = FakeEditor()
        editor.snapshot.isVisible = false
        let reconciler = OpenNoteReconciler(classify: { _ in .close })

        let result = await reconciler.reconcile(
            change: .external,
            effects: editor.effects()
        )

        #expect(result == .deferred)
        #expect(!editor.events.contains("close"))
    }

    @Test("a peer edit over an edit the editor has not reported keeps the edit")
    func unreportedEditSurvivesPeerEdit() async {
        let editor = FakeEditor()
        editor.disk = "peer"
        editor.liveEditor = EditorCurrent(
            latest: DocumentSnapshot(generation: 2, content: "base + typed mid-stream"),
            behind: false)
        let reconciler = OpenNoteReconciler()

        let result = await reconciler.reconcile(change: .external, effects: editor.effects())

        #expect(result == .applied)
        #expect(!editor.events.contains("adopt:peer"))
        #expect(editor.events.last == "keep:base:diverged")
        #expect(editor.snapshot.draft == "base + typed mid-stream")
    }

    @Test("a peer delete over an edit the editor has not reported keeps the draft open")
    func unreportedEditSurvivesPeerDelete() async {
        let editor = FakeEditor()
        editor.disk = nil
        editor.liveEditor = EditorCurrent(
            latest: DocumentSnapshot(generation: 2, content: "base + typed inside the debounce"),
            behind: false)
        let reconciler = OpenNoteReconciler()

        let result = await reconciler.reconcile(change: .external, effects: editor.effects())

        #expect(result == .applied)
        #expect(!editor.events.contains("close"))
        #expect(editor.events.last == "keep:base:peerDeleted")
    }

    @Test("the editor is read before the save is drained and disk is read")
    func capturesBeforeGathering() async {
        let editor = FakeEditor()
        editor.disk = "peer"
        var factsSeen: OpenNoteReconcileFacts?
        let reconciler = OpenNoteReconciler { facts in
            factsSeen = facts
            return .leave
        }
        editor.liveEditor = EditorCurrent(
            latest: DocumentSnapshot(generation: 2, content: "live"), behind: false)

        _ = await reconciler.reconcile(change: .external, effects: editor.effects())

        #expect(Array(editor.events.prefix(3)) == ["current", "drain", "read:note"])
        #expect(factsSeen?.draft == "live")
        #expect(factsSeen?.editedDuringCycle == true)
    }
}

import Testing

@testable import FutoNotesNative

@Suite("Open-note reconciler")
@MainActor
struct OpenNoteReconcilerTests {
    @MainActor
    final class Signal {
        private var continuation: CheckedContinuation<Void, Never>?
        private(set) var isWaiting = false

        func wait() async {
            isWaiting = true
            await withCheckedContinuation { continuation = $0 }
        }

        func release() {
            continuation?.resume()
            continuation = nil
        }
    }

    @MainActor
    final class FakeEditor {
        var snapshot = OpenNoteEditorSnapshot(
            id: "note",
            base: "base",
            draft: "base",
            isFocused: false,
            isVisible: true,
            editVersion: 0
        )
        var disk: String? = "base"
        var events: [String] = []
        var mutateWhileReading: (() -> Void)?

        func effects() -> OpenNoteReconcileEffects {
            OpenNoteReconcileEffects(
                snapshot: { self.snapshot },
                cancelAndDrainSave: { self.events.append("drain") },
                readDisk: { id in
                    self.events.append("read:\(id)")
                    self.mutateWhileReading?()
                    return self.disk
                },
                resumeDraftSave: { self.events.append("resume-save") },
                followRename: { toId in
                    self.events.append("rename:\(toId)")
                    self.snapshot.id = toId
                },
                adopt: { content in
                    self.events.append("adopt:\(content)")
                    self.snapshot.base = content
                    self.snapshot.draft = content
                },
                keepDraft: { base, reason in
                    self.events.append("keep:\(base):\(reason)")
                    self.snapshot.base = base
                },
                close: { self.events.append("close") }
            )
        }
    }

    private func reconcile(
        _ disposition: OpenNoteDisposition,
        editor: FakeEditor,
        change: OpenNoteChange = .external
    ) async -> OpenNoteReconcileResult {
        let reconciler = OpenNoteReconciler(classify: { _ in disposition })
        return await reconciler.reconcile(change: change, effects: editor.effects())
    }

    @Test("leave performs no editor mutation")
    func rendersLeave() async {
        let editor = FakeEditor()

        let result = await reconcile(.leave, editor: editor)

        #expect(result == .applied)
        #expect(editor.events == ["drain", "read:note"])
    }

    @Test("leave resumes a draft save cancelled for fact gathering")
    func leaveResumesDirtyDraftSave() async {
        let editor = FakeEditor()
        editor.snapshot.draft = "mine"

        _ = await reconcile(.leave, editor: editor)

        #expect(editor.events == ["drain", "read:note", "resume-save"])
    }

    @Test("a per-id delta skips an unrelated open note")
    func unrelatedDeltaDoesNotGather() async {
        let editor = FakeEditor()
        let change = OpenNoteChange(
            updatedIds: ["other"],
            deletedIds: [],
            renamed: [:]
        )

        let result = await reconcile(.close, editor: editor, change: change)

        #expect(result == .applied)
        #expect(editor.events.isEmpty)
    }

    @Test("adopt replaces the clean buffer")
    func rendersAdopt() async {
        let editor = FakeEditor()

        _ = await reconcile(.adopt(content: "peer"), editor: editor)

        #expect(editor.events == ["drain", "read:note", "adopt:peer"])
    }

    @Test("keep-draft rebases without replacing the buffer")
    func rendersKeepDraft() async {
        let editor = FakeEditor()
        editor.snapshot.draft = "mine"

        _ = await reconcile(
            .keepDraft(base: "peer", reason: .diverged),
            editor: editor
        )

        #expect(editor.events == ["drain", "read:note", "keep:peer:diverged"])
        #expect(editor.snapshot.draft == "mine")
        #expect(editor.snapshot.base == "peer")
    }

    @Test("close ends a visible clean session")
    func rendersClose() async {
        let editor = FakeEditor()

        _ = await reconcile(.close, editor: editor)

        #expect(editor.events == ["drain", "read:note", "close"])
    }

    @Test("a focused adopt is remembered and re-gathered after blur")
    func deferAdoptSettlesOnBlur() async {
        let editor = FakeEditor()
        editor.snapshot.isFocused = true
        editor.disk = "peer"
        var classifications = 0
        let reconciler = OpenNoteReconciler { facts in
            classifications += 1
            return facts.isFocused ? .deferAdopt : .adopt(content: facts.disk ?? "")
        }

        let deferred = await reconciler.reconcile(
            change: .external,
            effects: editor.effects()
        )
        #expect(deferred == .deferred)
        #expect(reconciler.shouldReconcileAfterFocusChange(isFocused: false))

        editor.snapshot.isFocused = false
        editor.disk = "newer peer"
        let settled = await reconciler.reconcile(
            change: .external,
            effects: editor.effects()
        )

        #expect(settled == .applied)
        #expect(classifications == 2)
        #expect(Array(editor.events.suffix(2)) == ["read:note", "adopt:newer peer"])
    }

    // MARK: - Against the real engine verdict

    /// The blur settle end to end, with the ENGINE deciding: a peer edit lands
    /// while the editor is focused and clean, the user types before blurring,
    /// and the settle pass must keep what was typed. The other tests inject a
    /// verdict, which cannot catch a shell that hands the classifier stale
    /// facts — the buffer as it was at defer time — so this one asks Rust.
    ///
    /// QA read a line vanishing here on 2026-08-07 (sy-04). The line was
    /// overwritten by a peer's own whole-file write, not by this path, and this
    /// test is what makes the difference provable rather than argued.
    @Test("a blur settle keeps work typed since the deferral")
    func engineSettlesBlurWithoutDiscardingTypedWork() async {
        let editor = FakeEditor()
        editor.snapshot.isFocused = true
        editor.disk = "peer"
        let reconciler = OpenNoteReconciler()

        let deferred = await reconciler.reconcile(change: .external, effects: editor.effects())
        #expect(deferred == .deferred)
        #expect(reconciler.shouldReconcileAfterFocusChange(isFocused: false))
        #expect(!editor.events.contains("adopt:peer"))

        // Typed between the deferral and the blur: the draft lives only in the
        // buffer, and the settle pass snapshots its edit epoch AFTER that
        // typing, so `draft != base` is the only thing protecting it.
        editor.snapshot.draft = "base typed"
        editor.snapshot.editVersion += 1
        editor.snapshot.isFocused = false

        let settled = await reconciler.reconcile(change: .external, effects: editor.effects())

        #expect(settled == .applied)
        #expect(editor.events.last == "keep:peer:diverged")
        #expect(editor.snapshot.draft == "base typed")
        #expect(editor.snapshot.base == "peer")
        #expect(!editor.events.contains { $0.hasPrefix("adopt:") })
    }

    /// The same sequence with nothing typed: the deferral was only ever about
    /// timing, so the peer's bytes arrive in the buffer on blur.
    @Test("a blur settle adopts the peer content when the draft stayed clean")
    func engineSettlesBlurWithAdoptWhenClean() async {
        let editor = FakeEditor()
        editor.snapshot.isFocused = true
        editor.disk = "peer"
        let reconciler = OpenNoteReconciler()

        let deferred = await reconciler.reconcile(change: .external, effects: editor.effects())
        #expect(deferred == .deferred)

        editor.snapshot.isFocused = false
        let settled = await reconciler.reconcile(change: .external, effects: editor.effects())

        #expect(settled == .applied)
        #expect(editor.events.last == "adopt:peer")
        #expect(editor.snapshot.draft == "peer")
    }

    /// Persist-or-park at the open-note seam, decided by the engine: a peer
    /// delete may not close a session holding unsaved work — the draft stays
    /// open for the flush verb's Recreated arm.
    @Test("a peer delete under a dirty draft keeps the draft instead of closing")
    func engineKeepsDraftOverPeerDelete() async {
        let editor = FakeEditor()
        editor.snapshot.draft = "mine"
        editor.disk = nil
        let reconciler = OpenNoteReconciler()

        let result = await reconciler.reconcile(change: .external, effects: editor.effects())

        #expect(result == .applied)
        #expect(editor.events.last == "keep:base:peerDeleted")
        #expect(!editor.events.contains("close"))
        #expect(editor.snapshot.draft == "mine")
    }

    @Test("rename is followed before the target is classified")
    func followsRenameBeforeDelete() async {
        let editor = FakeEditor()
        editor.disk = "peer"
        var factsSeen: [OpenNoteReconcileFacts] = []
        let reconciler = OpenNoteReconciler { facts in
            factsSeen.append(facts)
            if let renamedTo = facts.renamedTo {
                return .followRename(toId: renamedTo)
            }
            return facts.disk == nil ? .close : .adopt(content: facts.disk ?? "")
        }
        let change = OpenNoteChange(
            updatedIds: ["renamed"],
            deletedIds: ["note"],
            renamed: ["note": "renamed"]
        )

        _ = await reconciler.reconcile(change: change, effects: editor.effects())

        #expect(editor.events == ["rename:renamed", "drain", "read:renamed", "adopt:peer"])
        #expect(factsSeen.map(\.id) == ["note", "renamed"])
    }

    @Test("an identity change during the disk read drops the verdict")
    func staleIdentityDropsVerdict() async {
        let editor = FakeEditor()
        editor.disk = "peer"
        editor.mutateWhileReading = { editor.snapshot.id = "other" }

        let result = await reconcile(.adopt(content: "peer"), editor: editor)

        #expect(result == .stale)
        #expect(editor.events == ["drain", "read:note"])
    }

    @Test("a visibility change during the disk read drops the verdict")
    func staleVisibilityDropsVerdict() async {
        let editor = FakeEditor()
        editor.mutateWhileReading = { editor.snapshot.isVisible = false }

        let result = await reconcile(.close, editor: editor)

        #expect(result == .stale)
        #expect(!editor.events.contains("close"))
    }

    @Test("a disk read error never becomes a peer delete")
    func readFailureDropsVerdict() async {
        enum ReadFailure: Error { case failed }

        let editor = FakeEditor()
        var effects = editor.effects()
        effects.readDisk = { _ in throw ReadFailure.failed }

        let result = await OpenNoteReconciler(classify: { _ in .close })
            .reconcile(change: .external, effects: effects)

        #expect(result == .failed)
        #expect(!editor.events.contains("close"))
        #expect(editor.events == ["drain", "resume-save"])
    }

    @Test("sync intent received during initial load is replayed losslessly")
    func initialLoadBuffersSyncIntent() {
        var buffer = OpenNoteChangeBuffer()

        #expect(
            buffer.receive(
                OpenNoteChange(
                    updatedIds: ["note"],
                    deletedIds: [],
                    renamed: ["note": "renamed"]
                ),
                isLoaded: false
            ) == nil
        )
        #expect(
            buffer.receive(
                OpenNoteChange(
                    updatedIds: ["renamed"],
                    deletedIds: ["other"],
                    renamed: ["renamed": "final"]
                ),
                isLoaded: false
            ) == nil
        )

        let replay = buffer.finishInitialLoad()
        #expect(replay.updatedIds == ["note", "renamed"])
        #expect(replay.deletedIds == ["other"])
        #expect(replay.renamed == ["note": "renamed", "renamed": "final"])
        #expect(buffer.finishInitialLoad() == .external)
    }

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
}

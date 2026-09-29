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
        /// What the editor's read answers. `.captured` text the shell has not
        /// heard yet (a streaming note's withheld `change`, or one still in the
        /// 200 ms debounce) is merged into the shell copy exactly as
        /// NoteEditorView does: through the path a `change` takes.
        var liveEditor: EditorCaptureOutcome?

        func effects() -> OpenNoteReconcileEffects {
            OpenNoteReconcileEffects(
                snapshot: { self.snapshot },
                captureEditor: {
                    self.events.append("capture")
                    let outcome = self.liveEditor ?? .captured(self.snapshot.draft)
                    if case .captured(let live) = outcome, live != self.snapshot.draft {
                        self.snapshot.draft = live
                        self.snapshot.editVersion += 1
                    }
                    return outcome
                },
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
        #expect(editor.events == ["capture", "drain", "read:note"])
    }

    @Test("leave resumes a draft save cancelled for fact gathering")
    func leaveResumesDirtyDraftSave() async {
        let editor = FakeEditor()
        editor.snapshot.draft = "mine"

        _ = await reconcile(.leave, editor: editor)

        #expect(editor.events == ["capture", "drain", "read:note", "resume-save"])
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

        #expect(editor.events == ["capture", "drain", "read:note", "adopt:peer"])
    }

    @Test("keep-draft rebases without replacing the buffer")
    func rendersKeepDraft() async {
        let editor = FakeEditor()
        editor.snapshot.draft = "mine"

        _ = await reconcile(
            .keepDraft(base: "peer", reason: .diverged),
            editor: editor
        )

        #expect(editor.events == ["capture", "drain", "read:note", "keep:peer:diverged"])
        #expect(editor.snapshot.draft == "mine")
        #expect(editor.snapshot.base == "peer")
    }

    @Test("close ends a visible clean session")
    func rendersClose() async {
        let editor = FakeEditor()

        _ = await reconcile(.close, editor: editor)

        #expect(editor.events == ["capture", "drain", "read:note", "close"])
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
        // The kept baseline is the PRE-pull base, not the peer's bytes: that is
        // what leaves the next flush a `current != base` three-way it can park
        // as a conflict copy instead of a fast-forward over the peer (#89).
        #expect(editor.events.last == "keep:base:diverged")
        #expect(editor.snapshot.draft == "base typed")
        #expect(editor.snapshot.base == "base")
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

        #expect(
            editor.events == ["rename:renamed", "capture", "drain", "read:renamed", "adopt:peer"])
        #expect(factsSeen.map(\.id) == ["note", "renamed"])
    }

    @Test("an identity change during the disk read drops the verdict")
    func staleIdentityDropsVerdict() async {
        let editor = FakeEditor()
        editor.disk = "peer"
        editor.mutateWhileReading = { editor.snapshot.id = "other" }

        let result = await reconcile(.adopt(content: "peer"), editor: editor)

        #expect(result == .stale)
        #expect(editor.events == ["capture", "drain", "read:note"])
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
        #expect(editor.events == ["capture", "drain", "resume-save"])
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

    // MARK: - The classifier reads the live editor (RC-08)
    //
    // The shell's draft is kept current only by `change` messages, and the
    // editor withholds those while a large note streams and for the 200 ms
    // change debounce. "A busy editor's silence cannot be read as nothing to
    // lose" (docs/spec/editor.md): each case below had an edit only the
    // editor knew about, and the verdict used to be taken on the shell's copy.

    @Test("a peer edit over an edit the editor has not reported keeps the edit")
    func unreportedEditSurvivesPeerEdit() async {
        let editor = FakeEditor()
        editor.disk = "peer"
        editor.liveEditor = .captured("base + typed mid-stream")
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
        editor.liveEditor = .captured("base + typed inside the debounce")
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
        editor.liveEditor = .captured("live")

        _ = await reconciler.reconcile(change: .external, effects: editor.effects())

        #expect(Array(editor.events.prefix(3)) == ["capture", "drain", "read:note"])
        #expect(factsSeen?.draft == "live")
        #expect(factsSeen?.editedDuringCycle == true)
    }

    /// A live renderer too busy to answer (an edited note finishing its
    /// streamed tail) may hold exactly the edit the shell lacks, so neither an
    /// adopt nor a close may be taken on the shell's copy. The read already
    /// made the editor finish; its `change` then reaches the ordinary save,
    /// whose flush verb parks it against the peer's bytes.
    @Test("an editor too busy to answer is never adopted over or closed")
    func busyEditorGetsNoVerdict() async {
        for disk in ["peer", nil] as [String?] {
            let editor = FakeEditor()
            editor.disk = disk
            editor.liveEditor = .timedOut
            let reconciler = OpenNoteReconciler()

            let result = await reconciler.reconcile(change: .external, effects: editor.effects())

            #expect(result == .stale)
            #expect(!editor.events.contains { $0.hasPrefix("adopt") || $0 == "close" })
            #expect(!editor.events.contains("drain"))
        }
    }

    @Test("an editor now showing another note gives no verdict")
    func foreignDocumentGetsNoVerdict() async {
        let editor = FakeEditor()
        editor.disk = nil
        editor.liveEditor = .notOurs
        let reconciler = OpenNoteReconciler()

        let result = await reconciler.reconcile(change: .external, effects: editor.effects())

        #expect(result == .stale)
        #expect(!editor.events.contains("close"))
    }

    /// A wedged renderer (or one with no document) never presented an
    /// editable document, so the shell copy is the freshest body there is and
    /// sync must not wait on it forever — the exit rule (editorExitBody).
    @Test("an editor with no live document is classified on the shell copy")
    func deadEditorStillReconciles() async {
        let editor = FakeEditor()
        editor.disk = "peer"
        editor.liveEditor = .noLiveDocument
        let reconciler = OpenNoteReconciler()

        let result = await reconciler.reconcile(change: .external, effects: editor.effects())

        #expect(result == .applied)
        #expect(editor.events.last == "adopt:peer")
    }

    @Test("a hidden editor is not read: the shared WebView shows another note")
    func hiddenEditorIsNotRead() async {
        let editor = FakeEditor()
        editor.snapshot.isVisible = false
        editor.liveEditor = .captured("the visible note's text")
        let reconciler = OpenNoteReconciler(classify: { _ in .close })

        let result = await reconciler.reconcile(change: .external, effects: editor.effects())

        #expect(result == .deferred)
        #expect(!editor.events.contains("capture"))
        #expect(editor.snapshot.draft == "base")
    }
}

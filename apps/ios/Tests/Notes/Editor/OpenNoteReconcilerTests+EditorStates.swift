import Testing

@testable import FutoNotesNative

extension OpenNoteReconcilerTests {
    /// A live renderer too busy to answer (an edited note finishing its
    /// streamed tail) may hold exactly the edit the shell lacks, so neither an
    /// adopt nor a close may be taken on the shell's copy. The read already
    /// made the editor finish; its `change` then reaches the ordinary save,
    /// whose flush verb parks it against the peer's bytes.
    @Test("an editor too busy to answer is never adopted over, closed, or read again")
    func busyEditorGetsNoVerdict() async {
        for disk in ["peer", nil] as [String?] {
            let editor = FakeEditor()
            editor.disk = disk
            editor.liveEditor = EditorCurrent(latest: nil, behind: true)
            let reconciler = OpenNoteReconciler()

            let result = await reconciler.reconcile(change: .external, effects: editor.effects())

            #expect(result == .unread)
            #expect(!editor.events.contains { $0.hasPrefix("adopt") || $0 == "close" })
            #expect(!editor.events.contains("drain"))
        }
    }

    @Test("an editor now showing another note gives no verdict")
    func foreignDocumentGetsNoVerdict() async {
        let editor = FakeEditor()
        editor.disk = nil
        editor.liveEditor = EditorCurrent(latest: nil, behind: true)
        let reconciler = OpenNoteReconciler()

        let result = await reconciler.reconcile(change: .external, effects: editor.effects())

        #expect(result == .unread)
        #expect(!editor.events.contains("close"))
    }

    @Test("an editor with no live document is classified on the shell copy")
    func deadEditorStillReconciles() async {
        let editor = FakeEditor()
        editor.disk = "peer"
        editor.liveEditor = EditorCurrent(latest: nil, behind: false)
        let reconciler = OpenNoteReconciler()

        let result = await reconciler.reconcile(change: .external, effects: editor.effects())

        #expect(result == .applied)
        #expect(editor.events.last == "adopt:peer")
    }

    @Test("a hidden editor is not read: the shared WebView shows another note")
    func hiddenEditorIsNotRead() async {
        let editor = FakeEditor()
        editor.snapshot.isVisible = false
        editor.liveEditor = EditorCurrent(
            latest: DocumentSnapshot(generation: 2, content: "the visible note's text"),
            behind: false)
        let reconciler = OpenNoteReconciler(classify: { _ in .close })

        let result = await reconciler.reconcile(change: .external, effects: editor.effects())

        #expect(result == .deferred)
        #expect(!editor.events.contains("current"))
        #expect(editor.snapshot.draft == "base")
    }
    @Test func refusedAdoptionRemainsEligibleForNextBlur() async {
        let editor = FakeEditor()
        let reconciler = OpenNoteReconciler(classify: { _ in .adopt(content: "peer") })
        var effects = editor.effects()
        effects.adopt = { _ in false }
        let result = await reconciler.reconcile(change: .external, effects: effects)
        #expect(result == .unread)
        #expect(reconciler.shouldReconcileAfterFocusChange(isFocused: false))
        _ = await reconciler.reconcile(change: .external, effects: editor.effects())
        #expect(!reconciler.shouldReconcileAfterFocusChange(isFocused: false))
    }
}

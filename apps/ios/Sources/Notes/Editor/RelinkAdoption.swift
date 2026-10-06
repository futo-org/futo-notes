import Foundation

/// Rebase each refused conditional relink against the next delivered document.
@MainActor
func settleRelinkAdoption(
    flushed: String,
    relinkedBody: String,
    awaitCurrent: () async -> EditorCurrent,
    liveContent: () -> String,
    receiveChange: (String) -> Void,
    setBaseline: (String) -> Void,
    apply: (String, Int) async -> Bool
) async {
    for _ in 0..<3 {
        let current = await awaitCurrent()
        guard current.canProceed else { return }
        if let live = current.latest?.content, live != liveContent() { receiveChange(live) }
        let rebase = rebasedOnRelink(
            flushed: flushed, live: liveContent(), relinkedBody: relinkedBody)
        setBaseline(rebase.savedContent)
        guard rebase.adoptIntoEditor, let generation = current.latest?.generation else { return }
        if await apply(rebase.content, generation) { return }
    }
}

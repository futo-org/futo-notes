import Foundation

extension NotesStore {
    /// Budget handed to the engine's bounded search-readiness wait — the
    /// 200×25ms this shell's former poll loop allowed.
    private static let searchReadyTimeoutMs: UInt64 = 5_000

    /// Await keyword readiness through the shared single-flight wait.
    private func awaitSearchReady() async -> Bool {
        let wait =
            searchReadyWait
            ?? Task { [vault] in
                await vault.waitUntilSearchReady(timeoutMs: Self.searchReadyTimeoutMs)
            }
        searchReadyWait = wait
        let ready = await wait.value
        if !ready, searchReadyWait == wait { searchReadyWait = nil }
        return ready
    }

    /// A cancelled keystroke search exits around the shared engine wait without
    /// cancelling readiness for other searches. A timeout returns empty while
    /// the index continues healing.
    func search(_ query: String, limit: UInt32 = 50) async -> [SearchHit] {
        if Task.isCancelled { return [] }
        guard await awaitSearchReady() else { return [] }
        if Task.isCancelled { return [] }
        return (try? await vault.search(query, limit: limit)) ?? []
    }
}

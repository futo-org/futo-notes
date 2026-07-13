import Foundation

/// Off-main owner of the Rust `SearchEngine` (UniFFI) — BM25 keyword search
/// over the vault. Mirrors the `NoteVault` pattern:
/// the engine is reached only through this actor's executor, so index opens,
/// rescans, and queries can never touch the main actor.
///
/// The engine is LAZY: nothing is constructed until the first query/notify, so
/// app start never pays the index-open cost. While `keywordReady()` is false
/// (engine still warming or failed), the list UI keeps its in-memory substring
/// fallback (NoteListView).
actor SearchService {
    private let notesRoot: String
    private var engine: SearchEngine?
    /// When the engine constructor last failed. We back off for `retryCooldown`
    /// after a failure — so we don't reopen the Tantivy index on every keystroke
    /// — but we DO retry afterwards, so a transient failure (a stale index lock,
    /// momentary disk pressure) self-heals within the session instead of latching
    /// keyword search off until the app is relaunched (F13). `nil` = never failed
    /// / already recovered. An explicit `rescan()` (live pull / foreground
    /// catch-up) clears it to retry immediately, since a rescan is not a hot path.
    private var lastInitFailure: Date?
    private let retryCooldown: TimeInterval = 15

    init(notesRoot: String) {
        self.notesRoot = notesRoot
    }

    /// Lazily construct the engine with its index under Application
    /// Support/search — a per-app container OUTSIDE the vault, so sync and the
    /// Settings full reset never touch (or upload) index files.
    private func ensureEngine() -> SearchEngine? {
        if let engine { return engine }
        // Within the cooldown after a failed open: stay on the substring fallback
        // instead of hammering the index open on every keystroke.
        if let failedAt = lastInitFailure, Date().timeIntervalSince(failedAt) < retryCooldown {
            return nil
        }
        let support = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let indexDir = support.appendingPathComponent("search", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: indexDir, withIntermediateDirectories: true)
        do {
            let e = try SearchEngine(notesRoot: notesRoot, indexDir: indexDir.path)
            // First open: bring the index up to date with the vault (cheap when
            // it already is). Runs on this actor, never on main.
            e.rescan()
            engine = e
            lastInitFailure = nil
            return e
        } catch {
            print("SearchEngine init failed: \(error)")
            lastInitFailure = Date()
            return nil
        }
    }

    /// Whether the keyword index can serve queries. The first call constructs
    /// the engine (off-main); until it returns true the UI stays on substring.
    func keywordReady() -> Bool {
        ensureEngine()?.keywordReady() ?? false
    }

    /// BM25 query. Returns [] on engine failure — the caller falls back.
    func query(_ query: String, limit: UInt32) -> [SearchHit] {
        guard let engine = ensureEngine() else { return [] }
        return (try? engine.query(query: query, limit: limit)) ?? []
    }

    /// Full re-index of the vault (live pull / folder delete — many files
    /// changed at once). A rescan is not a per-keystroke hot path, so it clears
    /// any init-failure cooldown to retry the engine open immediately — a live
    /// pull or foreground catch-up is a natural recovery point (F13).
    func rescan() {
        lastInitFailure = nil
        ensureEngine()?.rescan()
    }

    // ── Incremental notifications (NotesStore mutations) ──
    // Fire-and-forget nonisolated wrappers so main-actor callers never await
    // the actor hop on hot paths (write fires per autosave debounce).

    nonisolated func noteChanged(_ id: String) {
        Task { await self.notifyChanged(relPath: id + ".md") }
    }

    nonisolated func noteRemoved(_ id: String) {
        Task { await self.notifyRemoved(relPath: id + ".md") }
    }

    nonisolated func noteRenamed(from oldId: String, to newId: String) {
        Task { await self.notifyRenamed(from: oldId + ".md", to: newId + ".md") }
    }

    nonisolated func rescanAsync() {
        Task { await self.rescan() }
    }

    private func notifyChanged(relPath: String) {
        ensureEngine()?.notifyChanged(relPath: relPath)
    }

    private func notifyRemoved(relPath: String) {
        ensureEngine()?.notifyRemoved(relPath: relPath)
    }

    private func notifyRenamed(from: String, to: String) {
        ensureEngine()?.notifyRenamed(from: from, to: to)
    }
}

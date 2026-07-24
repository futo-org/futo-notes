import Combine
import Foundation

/// The only native owner of the Rust local-note store. Every blocking FFI call
/// runs on this actor, never on the main actor.
actor NoteVault {
    /// `nonisolated(unsafe)`: the UniFFI handle is thread-safe (the Rust
    /// object is Send + Sync), and `waitUntilSearchReady` must reach it
    /// without queueing on this actor. Every other use stays actor-isolated.
    nonisolated(unsafe) private let core: NoteStore

    init(notesRoot: String) {
        core = NoteStore(notesRoot: notesRoot)
    }

    func bootstrap(indexDir: String) throws -> NoteBootstrap {
        try core.bootstrap(indexDir: indexDir)
    }

    func scan() -> NoteSnapshot { core.scan() }
    func read(_ id: String) -> String { core.read(id: id) }
    func exists(_ id: String) -> Bool { core.exists(id: id) }

    func write(_ id: String, content: String) throws -> NoteMutation {
        try core.write(id: id, content: content)
    }

    /// THE draft-saving verb (persist-or-park, ADR-0001 / issue #37): the
    /// engine resolves every save surprise itself — wrote / converged /
    /// recreated at the original id / parked as a conflict copy — under its
    /// own per-workflow serialization, and returns the disposition plus the
    /// mutation to project. This replaced the Swift-side
    /// writeIfUnchanged → createIfAbsent → park composition, whose
    /// check-then-act windows spanned FFI calls (PKT-10 P1a/P1b).
    func flushDraft(_ id: String, base: String, content: String) throws -> FlushDraftResult {
        try core.flushDraft(id: id, base: base, content: content)
    }

    func createNote(title: String, folder: String) throws -> NoteMutation {
        try core.createNote(title: title, folder: folder, content: "")
    }

    func delete(_ id: String) throws -> NoteMutation { try core.delete(id: id) }

    func rename(oldId: String, newId: String) throws -> NoteMutation {
        try core.rename(oldId: oldId, newId: newId)
    }

    func moveNote(_ id: String, folder: String) throws -> NoteMutation {
        try core.moveNote(id: id, folder: folder)
    }

    func createFolder(_ path: String) throws -> NoteMutation {
        try core.createFolder(path: path)
    }

    func renameFolder(from: String, to: String) throws -> NoteMutation {
        try core.renameFolder(from: from, to: to)
    }

    func moveFolder(from: String, destinationParent: String) throws -> NoteMutation {
        try core.moveFolder(from: from, destinationParent: destinationParent)
    }

    func deleteFolder(_ folder: String) throws -> NoteMutation {
        try core.deleteFolder(folder: folder)
    }

    func search(_ query: String, limit: UInt32) throws -> [SearchHit] {
        try core.search(query: query, limit: limit)
    }

    /// The engine wait blocks, so run it on overcommitting GCD rather than the
    /// Swift cooperative pool. `nonisolated` keeps it off the note-workflow
    /// actor queue (see `SearchReadinessWaitTests`).
    nonisolated func waitUntilSearchReady(timeoutMs: UInt64) async -> Bool {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async { [core] in
                continuation.resume(returning: core.waitUntilSearchReady(timeoutMs: timeoutMs))
            }
        }
    }

    func rescan() { core.rescan() }
    func reset() throws { try core.reset() }
}

/// An open editor's unsaved draft: the note `id` to persist, the `content` to
/// write, and `base` — the content the editor believes is on disk (its
/// `savedContent`). `base` is what the engine's flush verb
/// (`NotesStore.flushDraft` → Rust `flush_draft`) compares against to detect
/// that the note changed underneath the editor, so a note deleted or
/// sync-adopted while backgrounded is neither resurrected nor clobbered.
/// Mirrors Android's `PendingDraft` (NotesStore.kt).
struct PendingDraft: Equatable {
    let id: String
    let base: String
    let content: String
}

enum NoteMutationOutcome<Value> {
    case committed(Value)
    case failed
}

func confirmedSavedContent(
    previousSavedContent: String,
    writtenContent: String,
    outcome: NoteMutationOutcome<Void>
) -> String {
    switch outcome {
    case .committed: writtenContent
    case .failed: previousSavedContent
    }
}

/// The open editor's unsaved-draft derivation — the ONE definition of "is there
/// an unsaved draft, for which note" (PKT-12 R5). Returns a draft keyed on the
/// LIVE `noteId` (so it re-keys by construction after a rename) whenever the body
/// has loaded and diverges from what's on disk; `nil` when clean or not yet
/// loaded. `savedContent` is both the dirty check and the flush's expected-prev
/// (`base`). Pure + top-level so it mirrors the Kotlin `derivePendingDraft`
/// exactly. SwiftUI `@State` can't be pulled from an escaping closure the way
/// Compose snapshot state can, so the editor PUSHES this derived value via
/// `.onChange` on every state change; the derivation stays the single source of
/// truth for "clean vs dirty" (no scattered set/clear sites, PKT-1 R1-R4).
func derivePendingDraft(loaded: Bool, noteId: String, savedContent: String, content: String)
    -> PendingDraft?
{
    (loaded && content != savedContent)
        ? PendingDraft(id: noteId, base: savedContent, content: content) : nil
}

/// What the live-pull conflict path (`NoteEditorView.adoptExternalChange`) does
/// to the OPEN editor once the engine's flush verb resolves a dirty draft.
enum AdoptFlushOutcome: Equatable {
    /// The draft is durable ON DISK at the original id — keep it in the editor.
    /// wrote/recreated installed it; converged means disk already equalled it.
    case keepDraft
    /// The draft was parked as a conflict copy — re-read and adopt the current
    /// on-disk peer version. The snapshot from before the flush is stale by
    /// definition because the flush performed its own serialized re-check.
    case reloadDisk
    /// The flush failed (I/O) — leave the draft dirty; the next signal retries.
    case retryLater
}

/// Map a flush disposition to the open-note adopt outcome. Pure + top-level (like
/// `derivePendingDraft`) so the persist-or-park arm choice — above all the
/// converged race, where an in-flight unconditional autosave lands the draft on
/// disk just before `flush_draft` runs — is a table test, not a device scenario.
///
/// `.converged` groups with `.wrote`/`.recreated`, NOT with `.parkedConflict`
/// (issue #37 F3): converged means the engine saw disk ALREADY hold the draft,
/// so the draft is the on-disk content. Adopting the caller's pre-flush `disk`
/// snapshot here would show a version no longer on disk, mark it clean, and let
/// the next keystroke's unconditional autosave destroy the just-persisted draft
/// with no conflict copy — a regression against the persist-or-park promise.
func adoptFlushOutcome(for disposition: FlushDisposition?) -> AdoptFlushOutcome {
    switch disposition {
    case .parkedConflict:
        return .reloadDisk
    case .wrote, .recreated, .converged:
        return .keepDraft
    case .none:
        return .retryLater
    }
}

/// SwiftUI projection of the canonical local-note store. The published arrays
/// are a cache only: Rust commits each workflow and returns every affected row.
/// This type is presentation glue plus the iOS lifecycle machinery the Rust
/// store cannot own — the scenePhase draft register and the transient banner.
@MainActor
final class NotesStore: ObservableObject {
    @Published private(set) var notes: [NoteItem] = []
    @Published private(set) var folders: [String] = []
    @Published private(set) var hasBootstrapped = false

    /// A short-lived status message shown as a bottom banner over the whole
    /// NavigationStack (list + any pushed editor). Used for sync-side events the
    /// user should notice but that don't warrant a dialog — e.g. a peer deleting
    /// the note you had open. Auto-clears after a few seconds. This is the iOS
    /// equivalent of the desktop `showGlobalToast` / Android `Toast`.
    @Published var transientMessage: String?
    private var transientMessageTask: Task<Void, Never>?

    /// Show `message` as the transient banner for ~3.5 s (a later call replaces
    /// the current one and restarts the timer).
    func showTransient(_ message: String) {
        transientMessageTask?.cancel()
        transientMessage = message
        transientMessageTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_500_000_000)
            if !Task.isCancelled { transientMessage = nil }
        }
    }

    let notesRoot: URL
    var onLocalChange: (() -> Void)?

    /// The open editors' unsaved-draft register (F8 jetsam guard). Each open
    /// editor claims a token and publishes its DERIVED draft (`derivePendingDraft`)
    /// under that token on every state change; the app's scenePhase handler calls
    /// `flushPendingEditor()` when leaving `.active`, flushing every live editor's
    /// draft so an edit caught inside the 400 ms autosave debounce is persisted
    /// before the OS can jetsam the app. Pushed down here so the scenePhase handler
    /// never reaches into editor internals. Mirrors Android's `PendingEditorDraft`.
    ///
    /// A MAP keyed by token, NOT a single slot: during a NavigationStack push/pop
    /// several editors briefly coexist (wikilink chains share one WebView), so a
    /// single slot would let the incoming editor's publish EVICT an outgoing dirty
    /// editor's draft — a background+kill in that window would then flush nothing
    /// and lose its edit (PKT-1 R2). Per-token entries never touch each other, so
    /// the eviction is impossible by construction; `releaseDraftOwnership` removes
    /// only the caller's own entry.
    private var draftSeq: UInt64 = 0
    private var draftRegister: [UInt64: PendingDraft] = [:]
    private var oneShotDraftTokens: Set<UInt64> = []

    /// A newly-appeared editor claims a register entry; returns its unique token.
    /// Entries are keyed by it, so editors overlapping during a push/pop
    /// transition never evict each other's draft (PKT-1 R2).
    func claimDraftOwnership() -> UInt64 {
        draftSeq += 1
        return draftSeq
    }

    /// The editor publishes (or clears, with `nil`) its DERIVED draft under its
    /// own `token` — called reactively on every state change. Replaces the old
    /// hand-synced set/clear sites: the register reflects the derivation's verdict
    /// (`content != savedContent`) on demand, so a completed save / adopted remote
    /// clears the draft by construction (PKT-1 R1). Never touches another editor's
    /// entry.
    func publishDraft(token: UInt64, _ draft: PendingDraft?) {
        draftRegister[token] = draft
    }

    /// The editor left the screen — removes only its own entry, leaving any
    /// overlapping editor's draft intact.
    func releaseDraftOwnership(token: UInt64) {
        draftRegister[token] = nil
        oneShotDraftTokens.remove(token)
    }

    /// Keep a leaving editor's final dirty snapshot registered until its
    /// asynchronous flush has durably written or parked the draft.
    func retainDraftUntilFlushed(token: UInt64) {
        guard draftRegister[token] != nil else { return }
        oneShotDraftTokens.insert(token)
    }

    private func completeRetainedDraft(_ draft: PendingDraft) {
        let completedTokens = oneShotDraftTokens.filter { draftRegister[$0] == draft }
        for token in completedTokens {
            draftRegister[token] = nil
            oneShotDraftTokens.remove(token)
        }
    }

    private func retainedDraftSnapshot(for id: String) -> [UInt64: PendingDraft] {
        Dictionary(
            uniqueKeysWithValues: oneShotDraftTokens.compactMap { token in
                guard let draft = draftRegister[token], draft.id == id else { return nil }
                return (token, draft)
            })
    }

    private func completeRetainedDraftSnapshot(_ snapshot: [UInt64: PendingDraft]) {
        for (token, draft) in snapshot where draftRegister[token] == draft {
            draftRegister[token] = nil
            oneShotDraftTokens.remove(token)
        }
    }

    private func discardDrafts(for id: String) {
        let tokens = draftRegister.compactMap { token, draft in draft.id == id ? token : nil }
        for token in tokens {
            draftRegister[token] = nil
            oneShotDraftTokens.remove(token)
        }
    }

    private func retargetRetainedDrafts(from oldId: String, to finalId: String) {
        for token in oneShotDraftTokens {
            guard let draft = draftRegister[token], draft.id == oldId else { continue }
            draftRegister[token] = PendingDraft(
                id: finalId,
                base: draft.base,
                content: draft.content
            )
        }
    }

    /// What each note's draft was flushed as during the current background episode
    /// (id → the exact `PendingDraft` last flushed), cleared by
    /// `rearmBackgroundFlush` on the next foreground. NOT a boolean latch: the
    /// scenePhase handler deliberately flushes at BOTH `.inactive` AND `.background`
    /// (belt-and-suspenders — a phase can jump straight to background), and a
    /// boolean latched-on-entry would drop a keystroke the WebView bridge delivers
    /// BETWEEN the two callbacks (the newest edit, lost on suspend/terminate —
    /// defeating the jetsam guard). Comparing the registered draft to the snapshot
    /// re-flushes only a CHANGED draft while skipping an identical re-flush (the
    /// anti-double-park property, which the engine's `flush_draft` park
    /// idempotency enforces on its own anyway).
    private var flushedThisEpisode: [String: PendingDraft] = [:]
    private let editorDraftCoordinator = EditorDraftCoordinator()
    private var editorDraftTail: Task<Void, Never>?

    /// Flush every live editor's pending draft to disk (scenePhase inactive/
    /// background). Coalesces by note id, keeping the highest-token (most recently
    /// claimed = incoming/visible) draft, so two editors overlapping on the SAME
    /// note during a transition issue exactly one conditional write instead of two
    /// racing on the same base (Android parity: LinkedHashMap last-registered wins).
    /// Within a background episode a given id's draft is flushed once UNLESS it
    /// changed since (see `flushedThisEpisode`). No-op when every draft is clean /
    /// closed; safe at every leave-active signal.
    func flushPendingEditor() {
        guard !draftRegister.isEmpty else { return }
        var byId: [String: (token: UInt64, draft: PendingDraft)] = [:]
        for (token, draft) in draftRegister {
            if let existing = byId[draft.id], existing.token >= token { continue }
            byId[draft.id] = (token, draft)
        }
        for entry in byId.values {
            let draft = entry.draft
            // Skip only an IDENTICAL re-flush this episode; a draft that changed
            // between .inactive and .background (a keystroke landing right at
            // backgrounding) still flushes, so the newest edit is never lost.
            if flushedThisEpisode[draft.id] == draft { continue }
            flushedThisEpisode[draft.id] = draft
            flushAsync(draft)
        }
    }

    /// Re-arm the per-episode flush snapshot — called on scenePhase `.active` so
    /// the next backgrounding flushes afresh.
    func rearmBackgroundFlush() {
        flushedThisEpisode.removeAll()
    }

    /// The off-main owner of the Rust vault. The single source of truth for the
    /// rules. All FS I/O happens behind this actor.
    private let vault: NoteVault

    init() {
        let root = NotesStore.resolveNotesRoot()
        NSLog("[NotesStore] notesRoot = \(root.path)")
        notesRoot = root
        vault = NoteVault(notesRoot: root.path)
        Task { await bootstrap() }
    }

    nonisolated static func resolveNotesRoot() -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        #if FUTO_DEBUG_BUILD
            return docs.appendingPathComponent("fake-notes", isDirectory: true)
        #else
            return docs.appendingPathComponent("futo-notes", isDirectory: true)
        #endif
    }

    nonisolated static func resolveSearchIndex() -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("search", isDirectory: true)
    }

    private func bootstrap() async {
        do {
            let result = try await vault.bootstrap(indexDir: Self.resolveSearchIndex().path)
            applySnapshot(result.snapshot)
            for warning in result.warnings {
                print("local-note bootstrap: \(warning)")
            }
        } catch {
            print("local-note bootstrap failed: \(error)")
            applySnapshot(await vault.scan())
        }
        hasBootstrapped = true
    }

    func reload() {
        Task { applySnapshot(await vault.scan()) }
    }

    private static func item(from metadata: NoteMetadata) -> NoteItem {
        NoteItem(
            id: metadata.id,
            title: metadata.title,
            folder: metadata.folder,
            modified: Date(timeIntervalSince1970: Double(metadata.modifiedMs) / 1000.0),
            preview: metadata.preview,
            richPreview: metadata.richPreview,
            tags: metadata.tags
        )
    }

    private func applySnapshot(_ snapshot: NoteSnapshot) {
        notes = snapshot.notes.map(Self.item(from:))
        folders = snapshot.folders
    }

    /// Positions are post-removal; clamp them against a stale shell cache.
    private func applyMutation(_ mutation: NoteMutation) {
        let affected = Set(mutation.removed).union(mutation.upserted.map { $0.note.id })
        var next = notes.filter { !affected.contains($0.id) }
        for entry in mutation.upserted {
            let position = min(Int(entry.position), next.count)
            next.insert(Self.item(from: entry.note), at: position)
        }
        notes = next
        folders = mutation.folders
        for warning in mutation.warnings {
            print("local-note mutation: \(warning)")
        }
    }

    func read(_ id: String) async -> String { await vault.read(id) }
    func exists(_ id: String) async -> Bool { await vault.exists(id) }

    func write(_ id: String, content: String) async -> NoteMutationOutcome<Void> {
        do {
            let retainedAtAdmission = retainedDraftSnapshot(for: id)
            applyMutation(try await vault.write(id, content: content))
            completeRetainedDraftSnapshot(retainedAtAdmission)
            onLocalChange?()
            return .committed(())
        } catch {
            print("write failed for \(id): \(error)")
            showTransient("Couldn't save note. Your changes are still pending.")
            return .failed
        }
    }

    /// Create a new note. Returns its id, or nil on failure.
    @discardableResult
    func createNote(title: String, folder: String = "") async -> String? {
        do {
            let mutation = try await vault.createNote(title: title, folder: folder)
            applyMutation(mutation)
            let createdId = mutation.finalId ?? title
            editorDraftCoordinator.reopen(createdId)
            onLocalChange?()
            return createdId
        } catch {
            print("createNote failed: \(error)")
            return nil
        }
    }

    func delete(_ id: String) async -> NoteMutationOutcome<Void> {
        let identity = editorDraftCoordinator.beginIdentityMutation(id)
        let pendingFlushes = editorDraftTail
        do {
            await pendingFlushes?.value
            applyMutation(try await vault.delete(id))
            discardDrafts(for: id)
            editorDraftCoordinator.finishIdentityMutation(identity, committed: true)
            onLocalChange?()
            return .committed(())
        } catch {
            editorDraftCoordinator.finishIdentityMutation(identity, committed: false)
            print("delete failed for \(id): \(error)")
            return .failed
        }
    }

    func deleteAsync(_ id: String) {
        Task {
            _ = await delete(id)
        }
    }

    @discardableResult
    func rename(oldId: String, newId: String) async -> String {
        let identity = editorDraftCoordinator.beginIdentityMutation(oldId)
        let pendingFlushes = editorDraftTail
        do {
            await pendingFlushes?.value
            let mutation = try await vault.rename(oldId: oldId, newId: newId)
            let finalId = mutation.finalId ?? oldId
            applyMutation(mutation)
            retargetRetainedDrafts(from: oldId, to: finalId)
            editorDraftCoordinator.finishIdentityMutation(identity, committed: true)
            editorDraftCoordinator.reopen(finalId)
            onLocalChange?()
            return finalId
        } catch {
            editorDraftCoordinator.finishIdentityMutation(identity, committed: false)
            print("rename failed \(oldId) -> \(newId): \(error)")
            return oldId
        }
    }

    /// Flush a pending draft through the engine's ONE draft-saving verb
    /// (persist-or-park, ADR-0001 / issue #37) and project the returned
    /// mutation. The engine decides the disposition — wrote / converged /
    /// recreated at the original id (edit-wins dirty-keep, sync.md — the same
    /// home the resume autosave rewrites, so the survive and jetsam paths
    /// converge with no duplicate copy) / parked as a conflict copy (the
    /// diverged note untouched, the edit surviving as a new note). The whole
    /// composition runs under the engine's serialization, so the old
    /// cross-FFI check-then-act windows (PKT-10 P1a/P1b) and the hand-rolled
    /// per-platform state machine are gone. Returns the disposition (nil on
    /// an I/O failure) so the live-pull conflict path can react; iOS remains
    /// the shell that never drops a draft (Android drops on skip until #38).
    @discardableResult
    func flushDraft(_ draft: PendingDraft) async -> FlushDisposition? {
        await flushDraftDirect(draft)
    }

    private func flushDraftDirect(_ draft: PendingDraft) async -> FlushDisposition? {
        do {
            let result = try await vault.flushDraft(
                draft.id, base: draft.base, content: draft.content)
            // Converged and already-parked outcomes carry no mutation —
            // nothing changed on disk, nothing to project or sync.
            if let mutation = result.mutation {
                applyMutation(mutation)
                onLocalChange?()
            }
            return result.disposition
        } catch {
            print("flush failed for \(draft.id): \(error)")
            return nil
        }
    }

    /// Fire-and-forget flush for contexts that cannot `await` —
    /// `NoteEditorView.onDisappear` (pop) and the app's scenePhase background
    /// handler (the F8 jetsam guard).
    func flushAsync(_ draft: PendingDraft) {
        guard let admission = editorDraftCoordinator.admit(draft.id) else { return }
        let previous = editorDraftTail
        editorDraftTail = Task { @MainActor in
            await previous?.value
            guard editorDraftCoordinator.permits(admission) else { return }
            if await flushDraftDirect(draft) != nil {
                completeRetainedDraft(draft)
            }
        }
    }

    func moveNote(_ id: String, toFolder folder: String) async -> NoteMutationOutcome<String> {
        let identity = editorDraftCoordinator.beginIdentityMutation(id)
        let pendingFlushes = editorDraftTail
        do {
            await pendingFlushes?.value
            let mutation = try await vault.moveNote(id, folder: folder)
            let finalId = mutation.finalId ?? id
            applyMutation(mutation)
            retargetRetainedDrafts(from: id, to: finalId)
            editorDraftCoordinator.finishIdentityMutation(identity, committed: true)
            editorDraftCoordinator.reopen(finalId)
            onLocalChange?()
            return .committed(finalId)
        } catch {
            editorDraftCoordinator.finishIdentityMutation(identity, committed: false)
            print("moveNote failed \(id) -> \(folder): \(error)")
            return .failed
        }
    }

    func deleteFolder(_ folder: String) {
        Task {
            do {
                applyMutation(try await vault.deleteFolder(folder))
                onLocalChange?()
            } catch {
                print("deleteFolder failed for \(folder): \(error)")
            }
        }
    }

    func createFolder(_ path: String) {
        Task {
            do {
                applyMutation(try await vault.createFolder(path))
                onLocalChange?()
            } catch {
                print("createFolder failed for \(path): \(error)")
            }
        }
    }

    func renameFolder(from: String, to: String) async -> String? {
        do {
            let mutation = try await vault.renameFolder(from: from, to: to)
            applyMutation(mutation)
            onLocalChange?()
            return mutation.finalFolder ?? to
        } catch {
            print("renameFolder failed \(from) -> \(to): \(error)")
            return nil
        }
    }

    func moveFolder(from: String, destinationParent: String) async -> String? {
        do {
            let mutation = try await vault.moveFolder(
                from: from, destinationParent: destinationParent)
            applyMutation(mutation)
            onLocalChange?()
            return mutation.finalFolder ?? from
        } catch {
            print("moveFolder failed \(from) -> \(destinationParent): \(error)")
            return nil
        }
    }

    func noteCount(under folder: String) -> Int {
        notes.filter { $0.folder == folder || $0.folder.hasPrefix(folder + "/") }.count
    }

    func subfolders(of folder: String) -> [String] {
        let prefix = folder.isEmpty ? "" : folder + "/"
        return folders.filter { path in
            guard path.hasPrefix(prefix) else { return false }
            let tail = String(path.dropFirst(prefix.count))
            return !tail.isEmpty && !tail.contains("/")
        }
    }

    func notes(in folder: String) -> [NoteItem] {
        notes.filter { $0.folder == folder }
    }

    func notePath(_ id: String) -> String {
        notesRoot.appendingPathComponent(id + ".md").path
    }

    /// Budget handed to the engine's bounded search-readiness wait — the
    /// 200×25ms this shell's former poll loop allowed.
    private static let searchReadyTimeoutMs: UInt64 = 5_000

    /// Share one blocking readiness wait across searches. Keep a successful
    /// task for later searches; discard a timeout so the self-healing index
    /// gets another bounded attempt.
    private var searchReadyWait: Task<Bool, Never>?

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

    func liveDataChanged() {
        Task {
            await vault.rescan()
            applySnapshot(await vault.scan())
        }
    }

    func fullReset() async {
        do {
            try await vault.reset()
            notes = []
            folders = []
        } catch {
            print("full reset failed: \(error)")
        }
    }
}

import Combine
import Foundation

/// The only native owner of the Rust local-note store. Every blocking FFI call
/// runs on this actor, never on the main actor.
actor NoteVault {
    private let core: NoteStore

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

    /// Conditional write for a backgrounded editor flush (see
    /// `NotesStore.flushAsync`): write `content` only if the note still holds
    /// `expected`. Returns the outcome plus, on a genuine write, the mutation to
    /// project into the list. The anti-resurrection / anti-clobber decision lives
    /// in the Rust store's `write_if_unchanged` — this is a thin off-main wrapper.
    func writeIfUnchanged(_ id: String, expected: String, content: String) throws
        -> ConditionalWrite
    {
        try core.writeIfUnchanged(id: id, expectedPrev: expected, content: content)
    }

    /// Atomically (re-)create the note at `id` with `content` ONLY IF absent
    /// (no-replace `hard_link` install, Rust store `create_if_absent`) — the
    /// peer-delete edit-wins recreate without a clobber race against an
    /// independent sync write (PKT-10 P1a). Returns `.created` (the caller
    /// reloads to project the new row) or `.existed`.
    func createIfAbsent(_ id: String, content: String) throws -> CreateOutcome {
        try core.createIfAbsent(id: id, content: content)
    }

    /// Atomically (WITHIN this actor) create a "<stem>" conflict copy holding
    /// `content` in `folder` — UNLESS a note whose title matches the stem already
    /// holds byte-identical content. The candidate scan reads DISK
    /// (`scan`/`read`) and the create runs with NO suspension in between, so
    /// two concurrent parks (a live-adopt conflict racing a scene-phase flush, or
    /// overlapping background episodes) that both route through this actor are
    /// serialized — they can't each mint a suffixed duplicate (PKT-10 P1b).
    /// Returns the create mutation, or nil if a matching copy already existed.
    func parkConflictCopyIfAbsent(stem: String, folder: String, content: String) throws
        -> NoteMutation?
    {
        let alreadyParked = core.scan().notes.contains { meta in
            meta.folder == folder && meta.title.hasPrefix(stem)
                && core.read(id: meta.id) == content
        }
        if alreadyParked { return nil }
        return try core.createNote(title: stem, folder: folder, content: content)
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

    func createFolder(_ path: String) throws -> String {
        try core.createFolder(path: path)
    }

    func renameFolder(from: String, to: String) throws -> NoteMutation {
        try core.renameFolder(from: from, to: to)
    }

    func deleteFolder(_ folder: String) throws -> NoteMutation {
        try core.deleteFolder(folder: folder)
    }

    func search(_ query: String, limit: UInt32) throws -> [SearchHit] {
        try core.search(query: query, limit: limit)
    }

    func keywordReady() -> Bool { core.keywordReady() }
    func rescan() { core.rescan() }
    func reset() throws { try core.reset() }
}

/// An open editor's unsaved draft: the note `id` to persist, the `content` to
/// write, and `base` — the content the editor believes is on disk (its
/// `savedContent`). `base` is the expected-previous for the conditional flush
/// (see `NotesStore.flushAsync` → `writeIfUnchanged`): the flush writes only if
/// the note still holds `base`, so a note deleted or sync-adopted while
/// backgrounded is neither resurrected nor clobbered. Mirrors Android's
/// `PendingDraft` (NotesStore.kt).
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

    /// What each note's draft was flushed as during the current background episode
    /// (id → the exact `PendingDraft` last flushed), cleared by
    /// `rearmBackgroundFlush` on the next foreground. NOT a boolean latch: the
    /// scenePhase handler deliberately flushes at BOTH `.inactive` AND `.background`
    /// (belt-and-suspenders — a phase can jump straight to background), and a
    /// boolean latched-on-entry would drop a keystroke the WebView bridge delivers
    /// BETWEEN the two callbacks (the newest edit, lost on suspend/terminate —
    /// defeating the jetsam guard). Comparing the registered draft to the snapshot
    /// re-flushes only a CHANGED draft while skipping an identical re-flush (the
    /// anti-double-park property, which `parkConflictCopyIfAbsent` idempotency
    /// enforces on its own anyway).
    private var flushedThisEpisode: [String: PendingDraft] = [:]

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
            result.warnings.forEach { print("local-note bootstrap: \($0)") }
        } catch {
            print("local-note bootstrap failed: \(error)")
            applySnapshot(await vault.scan())
        }
        hasBootstrapped = true
    }

    func reload() {
        Task { applySnapshot(await vault.scan()) }
    }

    func resortInPlace() {
        notes.sort { left, right in
            left.modified == right.modified ? left.id < right.id : left.modified > right.modified
        }
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

    /// The sole incremental cache seam. Renames, collision outcomes, and
    /// backlink rewrites are already complete when this is called.
    private func applyMutation(_ mutation: NoteMutation) {
        let removed = Set(mutation.removed)
        var next = notes.filter { !removed.contains($0.id) }
        for metadata in mutation.upserted {
            let item = Self.item(from: metadata)
            if let index = next.firstIndex(where: { $0.id == item.id }) {
                next[index] = item
            } else {
                next.insert(item, at: 0)
            }
        }
        notes = next
        mutation.warnings.forEach { print("local-note mutation: \($0)") }
    }

    private func finalId(_ mutation: NoteMutation, fallback: String) -> String {
        mutation.renamed.last?.to ?? mutation.upserted.first?.id ?? fallback
    }

    private func refreshFolders() async {
        folders = await vault.scan().folders
    }

    func read(_ id: String) async -> String { await vault.read(id) }
    func exists(_ id: String) async -> Bool { await vault.exists(id) }

    func write(_ id: String, content: String) async -> NoteMutationOutcome<Void> {
        do {
            applyMutation(try await vault.write(id, content: content))
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
            await refreshFolders()
            onLocalChange?()
            return finalId(mutation, fallback: title)
        } catch {
            print("createNote failed: \(error)")
            return nil
        }
    }

    func delete(_ id: String) {
        Task {
            do {
                applyMutation(try await vault.delete(id))
                await refreshFolders()
                onLocalChange?()
            } catch {
                print("delete failed for \(id): \(error)")
            }
        }
    }

    @discardableResult
    func rename(oldId: String, newId: String) async -> String {
        do {
            let mutation = try await vault.rename(oldId: oldId, newId: newId)
            applyMutation(mutation)
            await refreshFolders()
            onLocalChange?()
            return finalId(mutation, fallback: oldId)
        } catch {
            print("rename failed \(oldId) -> \(newId): \(error)")
            return oldId
        }
    }

    /// Fire-and-forget conditional flush of a pending draft from a context that
    /// cannot `await` — `NoteEditorView.onDisappear` (pop) and the app's scenePhase
    /// background handler. A conditional write (`writeIfUnchanged`): persist
    /// `draft.content` only if the note still holds `draft.base` (the content the
    /// editor last saw). One FFI call replaces the old `exists()`-then-`write()`
    /// sequence, collapsing its cross-FFI TOCTOU. NEVER drops the draft:
    /// `.wrote` reflects into the in-memory list; `.skippedMissing` (peer deleted)
    /// recreates the note at its original id — edit-wins dirty-keep, converging
    /// with the resume autosave on ONE home (no conflict-copy-vs-recreated-original
    /// dup); `.skippedChanged` (peer changed) parks the draft as a conflict copy so
    /// the edit survives WITHOUT clobbering the diverged note. (Diverges from
    /// Android's flush, which drops on skip; iOS is the only shell that makes the
    /// peer-delete "keeping local draft" promise.)
    func flushAsync(_ draft: PendingDraft) {
        Task {
            if await flush(draft) {
                completeRetainedDraft(draft)
            }
        }
    }

    private func flush(_ draft: PendingDraft) async -> Bool {
        do {
            let result = try await vault.writeIfUnchanged(
                draft.id, expected: draft.base, content: draft.content)
            switch result.outcome {
            case .wrote:
                if let mutation = result.mutation {
                    applyMutation(mutation)
                    onLocalChange?()
                }
                return result.mutation != nil
            case .skippedChanged:
                let disk = await vault.read(draft.id)
                if disk == draft.content { return true }
                return await parkDraftCopy(draft)
            case .skippedMissing:
                let created = try await vault.createIfAbsent(
                    draft.id, content: draft.content)
                if created == .created {
                    reload()
                    onLocalChange?()
                    return true
                }
                let disk = await vault.read(draft.id)
                if disk == draft.content { return true }
                return await parkDraftCopy(draft)
            }
        } catch {
            print("flush failed for \(draft.id): \(error)")
            showTransient("Couldn't save note. Your changes are still pending.")
            return false
        }
    }

    /// Preserve a draft that CONFLICTS with a genuinely different on-disk version
    /// (a peer CHANGED the note out from under the editor) as a
    /// "<title> (conflict YYYY-MM-DD)" copy, so the local edit survives without
    /// clobbering the peer's version. Shared by the flush's `.skippedChanged` arm
    /// and the live-pull conflict path (`adoptExternalChange`), so the
    /// conflict-copy naming lives in one place. (The peer-DELETE case does NOT come
    /// here — it is edit-wins re-create at the original id; see `flushAsync`.)
    /// Anti-clobber safe: creates a NEW note, never rewrites the diverged original.
    ///
    /// IDEMPOTENCY GUARD (conflict-copy combinatorial-explosion class — the
    /// 1081-object incident): the check-that-a-copy-doesn't-already-exist and the
    /// create are ONE serialized `NoteVault` operation reading DISK
    /// (`parkConflictCopyIfAbsent`), so two concurrent parks can't each mint a
    /// suffixed duplicate — the stale-cache / yield-before-create race the old
    /// in-`notes`-cache scan had (P1b). Only a genuine create refreshes state.
    func parkDraftCopy(_ draft: PendingDraft) async -> Bool {
        let parts = splitId(id: draft.id)
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        let stem = "\(parts.title) (conflict \(formatter.string(from: Date())))"
        do {
            guard let mutation = try await vault.parkConflictCopyIfAbsent(
                stem: stem, folder: parts.folder, content: draft.content)
            else { return true }  // an identical copy already existed — no duplicate
            applyMutation(mutation)
            onLocalChange?()
            return true
        } catch {
            print("parkDraftCopy failed for \(draft.id): \(error)")
            showTransient("Couldn't preserve conflicting edits. Your draft is still open.")
            return false
        }
    }

    @discardableResult
    func moveNote(_ id: String, toFolder folder: String) async -> String {
        do {
            let mutation = try await vault.moveNote(id, folder: folder)
            applyMutation(mutation)
            await refreshFolders()
            onLocalChange?()
            return finalId(mutation, fallback: id)
        } catch {
            print("moveNote failed \(id) -> \(folder): \(error)")
            return id
        }
    }

    @discardableResult
    func moveNoteCreatingFolder(_ id: String, folder: String) async -> String {
        do {
            _ = try await vault.createFolder(folder)
            let mutation = try await vault.moveNote(id, folder: folder)
            applyMutation(mutation)
            await refreshFolders()
            onLocalChange?()
            return finalId(mutation, fallback: id)
        } catch {
            print("moveNoteCreatingFolder failed \(id) -> \(folder): \(error)")
            return id
        }
    }

    func deleteFolder(_ folder: String) {
        Task {
            do {
                applyMutation(try await vault.deleteFolder(folder))
                await refreshFolders()
                onLocalChange?()
            } catch {
                print("deleteFolder failed for \(folder): \(error)")
            }
        }
    }

    func createFolder(_ path: String) {
        Task {
            do {
                _ = try await vault.createFolder(path)
                await refreshFolders()
                onLocalChange?()
            } catch {
                print("createFolder failed for \(path): \(error)")
            }
        }
    }

    func renameFolder(from: String, to: String) async -> Bool {
        do {
            applyMutation(try await vault.renameFolder(from: from, to: to))
            await refreshFolders()
            onLocalChange?()
            return true
        } catch {
            print("renameFolder failed \(from) -> \(to): \(error)")
            return false
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

    /// Search has no shell-owned fallback. The same Rust owner serves queries
    /// after its background reconciliation becomes ready.
    func search(_ query: String, limit: UInt32 = 50) async -> [SearchHit] {
        for _ in 0..<200 {
            if await vault.keywordReady() {
                return (try? await vault.search(query, limit: limit)) ?? []
            }
            if Task.isCancelled { return [] }
            try? await Task.sleep(nanoseconds: 25_000_000)
        }
        return []
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

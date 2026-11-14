import Combine
import Foundation

/// SwiftUI projection of the canonical local-note store. The published arrays
/// are a cache only: Rust commits each workflow and returns every affected row.
/// This type is presentation glue plus the iOS lifecycle machinery the Rust
/// store cannot own — the scenePhase draft register and the transient banner.
@MainActor
final class NotesStore: ObservableObject {
    @Published private(set) var notes: [NoteItem] = []
    @Published private(set) var folders: [String] = []
    @Published private(set) var hasBootstrapped = false
    @Published private(set) var sortOrder = NoteSortPreference.stored()
    @Published private(set) var localTreeChange: SyncSummary?

    /// A short-lived status message shown as a bottom banner over the whole
    /// NavigationStack (list + any pushed editor). Used for sync-side events the
    /// user should notice but that don't warrant a dialog — e.g. a peer deleting
    /// the note you had open. Auto-clears after a few seconds. This is the iOS
    /// equivalent of the desktop `showGlobalToast` / Android `showToast`.
    @Published var transientMessage: LocalizedMessage?
    private var transientMessageTask: Task<Void, Never>?

    /// How long the banner stays up: ~3.5 s. A debug UI test holds it open with
    /// `-FUTOTransientSeconds <n>`: XCUITest cannot watch for a banner while it
    /// blocks on a deep link or an animation, so a test that must see one while
    /// something else lands would otherwise race the clock.
    static let transientNanoseconds: UInt64 = {
        #if FUTO_DEBUG_BUILD
            let arguments = ProcessInfo.processInfo.arguments
            if let flag = arguments.firstIndex(of: "-FUTOTransientSeconds"),
                arguments.indices.contains(flag + 1), let seconds = UInt64(arguments[flag + 1])
            {
                return seconds * 1_000_000_000
            }
        #endif
        return 3_500_000_000
    }()

    /// Show `message` as the transient banner for ~3.5 s (a later call replaces
    /// the current one and restarts the timer).
    func showTransient(_ message: LocalizedMessage) {
        transientMessageTask?.cancel()
        transientMessage = message
        transientMessageTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: Self.transientNanoseconds)
            if !Task.isCancelled { transientMessage = nil }
        }
    }

    let notesRoot: URL
    var onLocalChange: (() -> Void)?

    /// Native editor ownership survives navigation and is retired atomically on reset.
    var draftSeq: UInt64 = 0
    var retiredDraftTokensThrough: UInt64 = 0
    var resetting = false
    var resetEpoch: UInt64 = 0
    /// What a draft owner wants done, once and synchronously, when a full reset retires its token
    /// (`whenRetired`); removed by `releaseDraftOwnership`.
    var retirementHandlers: [UInt64: @MainActor () -> Void] = [:]

    var folderMutationTail: Task<Bool, Never>?
    // Serialized so Rust and the shell always end on the same pick.
    private var sortOrderTail: Task<Void, Never>?
    private var localTreeChangeTail: Task<Void, Never>?

    /// The off-main owner of the Rust vault. The single source of truth for the
    /// rules. All FS I/O happens behind this actor.
    let vault: NoteVault
    private let searchIndex: URL

    init(notesRoot: URL? = nil, searchIndex: URL? = nil) {
        let root = notesRoot ?? NotesStore.resolveNotesRoot()
        NSLog("[NotesStore] notesRoot = \(root.path)")
        self.notesRoot = root
        self.searchIndex = searchIndex ?? Self.resolveSearchIndex()
        vault = NoteVault(notesRoot: root.path)
        Task { await bootstrap() }
    }

    nonisolated static func resolveNotesRoot() -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        #if FUTO_DEBUG_BUILD
            let defaultDirectoryName = "fake-notes"
        #else
            let defaultDirectoryName = "futo-notes"
        #endif
        return AppLaunchConfiguration.resolveNotesRoot(
            environment: ProcessInfo.processInfo.environment,
            documentsDirectory: docs,
            defaultDirectoryName: defaultDirectoryName
        )
    }

    nonisolated static func resolveSearchIndex() -> URL {
        let support = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0]
        return AppLaunchConfiguration.resolveSearchIndex(
            environment: ProcessInfo.processInfo.environment,
            applicationSupportDirectory: support
        )
    }

    func setSortOrder(_ order: NoteSortOrder) {
        let previous = sortOrderTail
        sortOrderTail = Task {
            await previous?.value
            let epoch = resetEpoch
            guard order != sortOrder, !resetting else { return }
            do {
                let snapshot = try await vault.setSortOrder(order)
                sortOrder = order
                NoteSortPreference.store(order)
                applySnapshot(snapshot, expectedEpoch: epoch)
            } catch {
                print("local-note sort order change failed: \(error)")
            }
        }
    }

    private func bootstrap() async {
        let epoch = resetEpoch
        do {
            let result = try await vault.bootstrap(
                indexDir: searchIndex.path,
                order: sortOrder
            )
            applySnapshot(result.snapshot, expectedEpoch: epoch)
            for warning in result.warnings {
                print("local-note bootstrap: \(warning)")
            }
        } catch {
            print("local-note bootstrap failed: \(error)")
            applySnapshot(await vault.scan(), expectedEpoch: epoch)
        }
        hasBootstrapped = true
    }

    private static func item(from metadata: NoteMetadata) -> NoteItem {
        NoteItem(
            id: metadata.id,
            title: metadata.title,
            folder: metadata.folder,
            modified: Date(timeIntervalSince1970: Double(metadata.modifiedMs) / 1000.0),
            richPreview: metadata.richPreview,
            tags: metadata.tags
        )
    }

    private func applySnapshot(_ snapshot: NoteSnapshot, expectedEpoch: UInt64) {
        guard expectedEpoch == resetEpoch, !resetting else { return }
        notes = snapshot.notes.map(Self.item(from:))
        folders = snapshot.folders
    }

    /// Positions are post-removal; clamp them against a stale shell cache.
    func applyMutation(_ mutation: NoteMutation, expectedEpoch: UInt64) {
        guard expectedEpoch == resetEpoch, !resetting else { return }
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

    /// Share one blocking readiness wait across searches. Keep a successful
    /// task for later searches; discard a timeout so the self-healing index
    /// gets another bounded attempt.
    var searchReadyWait: Task<Bool, Never>?

    /// A sync cycle wrote the vault. Serialize projection with prior cycles,
    /// then publish the same lossless summary to open editors only after the
    /// durable mutation is visible to the rest of the native shell.
    func localTreeChanged(_ summary: SyncSummary) {
        let epoch = resetEpoch
        guard !resetting else { return }
        let previous = localTreeChangeTail
        localTreeChangeTail = Task {
            await previous?.value
            guard epoch == resetEpoch, !resetting else { return }
            do {
                applyMutation(try await vault.refreshExternalChanges(summary), expectedEpoch: epoch)
            } catch {
                // Scoped projection should fail only for an engine/storage
                // error. Keep the shell usable with a recovery scan; normal
                // sync cycles never pay for a whole-vault refresh.
                print("external-change projection failed: \(error)")
                applySnapshot(await vault.refreshSnapshot(), expectedEpoch: epoch)
            }
            guard epoch == resetEpoch, !resetting else { return }
            localTreeChange = summary
        }
    }

    /// Files can change in Files while this app is suspended. Re-read on the vault actor,
    /// serialized with sync projection, without delaying the foreground shell.
    func refreshAfterForeground() async {
        let epoch = resetEpoch
        guard hasBootstrapped, !resetting else { return }
        let previous = localTreeChangeTail
        let refresh = Task { @MainActor in
            await previous?.value
            guard epoch == resetEpoch, !resetting else { return }
            applySnapshot(await vault.refreshSnapshot(), expectedEpoch: epoch)
        }
        localTreeChangeTail = refresh
        await refresh.value
    }

    func beginFullReset() {
        resetting = true
        resetEpoch += 1
        retiredDraftTokensThrough = draftSeq
        let retired = retirementHandlers
        retirementHandlers.removeAll()
        for handler in retired.values { handler() }
    }

    func fullReset() async throws {
        if !resetting { beginFullReset() }
        let epoch = resetEpoch
        defer {
            resetting = false
        }
        _ = await folderMutationTail?.value
        await localTreeChangeTail?.value
        try await vault.reset(epoch: epoch)
        notes = []
        folders = []
        localTreeChange = nil
        searchReadyWait = nil
    }
}

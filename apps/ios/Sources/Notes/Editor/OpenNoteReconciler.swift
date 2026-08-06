import Foundation

/// The editor state the open-note classifier consumes after the disk read.
struct OpenNoteEditorSnapshot: Equatable {
    var id: String
    var base: String
    var draft: String
    var isFocused: Bool
    var isVisible: Bool
    var editVersion: UInt64
}

/// The cycle facts relevant to the open editor. The full `SyncSummary` reaches
/// the shell; this focused value keeps the editor module independent of sync
/// counters and failure presentation.
struct OpenNoteChange: Equatable {
    var updatedIds: Set<String>
    var deletedIds: Set<String>
    var renamed: [String: String]

    static let external = OpenNoteChange(updatedIds: [], deletedIds: [], renamed: [:])

    init(updatedIds: Set<String>, deletedIds: Set<String>, renamed: [String: String]) {
        self.updatedIds = updatedIds
        self.deletedIds = deletedIds
        self.renamed = renamed
    }

    init(summary: SyncSummary) {
        updatedIds = Set(summary.updatedIds)
        deletedIds = Set(summary.deletedIds)
        renamed = Dictionary(
            summary.renamed.map { ($0.fromId, $0.toId) },
            uniquingKeysWith: { _, latest in latest }
        )
    }

    func affects(_ id: String) -> Bool {
        updatedIds.contains(id) || deletedIds.contains(id) || renamed[id] != nil
    }

    func merging(_ newer: OpenNoteChange) -> OpenNoteChange {
        OpenNoteChange(
            updatedIds: updatedIds.union(newer.updatedIds),
            deletedIds: deletedIds.union(newer.deletedIds),
            renamed: renamed.merging(newer.renamed) { _, latest in latest }
        )
    }
}

/// Retains lossless sync intent while the editor's initial disk read is in
/// flight. In particular, a rename cannot be replaced by a later update before
/// the editor becomes eligible to reconcile.
struct OpenNoteChangeBuffer {
    private var pending: OpenNoteChange?

    mutating func receive(
        _ change: OpenNoteChange,
        isLoaded: Bool
    ) -> OpenNoteChange? {
        guard !isLoaded else { return change }
        pending = pending?.merging(change) ?? change
        return nil
    }

    mutating func finishInitialLoad() -> OpenNoteChange {
        defer { pending = nil }
        return pending ?? .external
    }
}

struct OpenNoteReconcileFacts: Equatable {
    let id: String
    let base: String
    let draft: String
    let disk: String?
    let renamedTo: String?
    let isFocused: Bool
    let editedDuringCycle: Bool
}

struct OpenNoteReconcileEffects {
    var snapshot: @MainActor () -> OpenNoteEditorSnapshot?
    var cancelAndDrainSave: @MainActor () async -> Void
    var readDisk: @MainActor (String) async throws -> String?
    var resumeDraftSave: @MainActor () -> Void
    var followRename: @MainActor (String) -> Void
    var adopt: @MainActor (String) -> Void
    var keepDraft: @MainActor (String, KeepDraftReason) -> Void
    var close: @MainActor () -> Void
}

enum OpenNoteReconcileResult: Equatable {
    case applied
    case deferred
    case stale
    case failed
}

typealias OpenNoteClassifier =
    @MainActor (OpenNoteReconcileFacts) -> OpenNoteDisposition

/// The iOS executor for the engine's open-note disposition.
///
/// Every pass gathers facts, asks Rust once, then validates the live editor
/// snapshot exactly once before applying a synchronous effect. A reported
/// rename is one pass of the same verb and is followed by a fresh pass against
/// the target id, so a relocation can never be mistaken for a peer delete.
@MainActor
final class OpenNoteReconciler {
    nonisolated(unsafe) private let classify: OpenNoteClassifier
    private var hasDeferredAdopt = false

    nonisolated init() {
        classify = Self.classifyWithEngine
    }

    nonisolated init(classify: @escaping OpenNoteClassifier) {
        self.classify = classify
    }

    func shouldReconcileAfterFocusChange(isFocused: Bool) -> Bool {
        !isFocused && hasDeferredAdopt
    }

    func reconcile(
        change: OpenNoteChange,
        effects: OpenNoteReconcileEffects
    ) async -> OpenNoteReconcileResult {
        let cycleStartEditVersion = effects.snapshot()?.editVersion ?? 0
        var mustGatherTarget = false

        for _ in 0..<16 {
            guard !Task.isCancelled else { return .stale }
            guard let initial = effects.snapshot() else { return .stale }
            let renamedTo = change.renamed[initial.id]
            if !mustGatherTarget && change != .external && !change.affects(initial.id) {
                return .applied
            }

            if let renamedTo {
                let facts = OpenNoteReconcileFacts(
                    id: initial.id,
                    base: initial.base,
                    draft: initial.draft,
                    disk: nil,
                    renamedTo: renamedTo,
                    isFocused: initial.isFocused,
                    editedDuringCycle: initial.editVersion != cycleStartEditVersion
                )
                let disposition = classify(facts)
                guard effects.snapshot() == initial else { return .stale }
                guard case .followRename(let toId) = disposition else {
                    return apply(disposition, snapshot: initial, effects: effects)
                }
                effects.followRename(toId)
                mustGatherTarget = true
                continue
            }

            await effects.cancelAndDrainSave()
            guard !Task.isCancelled else { return .stale }
            guard let readTarget = effects.snapshot() else { return .stale }
            let disk: String?
            do {
                disk = try await effects.readDisk(readTarget.id)
            } catch {
                guard !Task.isCancelled else { return .stale }
                print("open-note disk read failed for \(readTarget.id): \(error)")
                effects.resumeDraftSave()
                return .failed
            }
            guard !Task.isCancelled else { return .stale }
            guard
                let current = effects.snapshot(),
                current.id == readTarget.id,
                current.isVisible == readTarget.isVisible
            else {
                return .stale
            }
            let facts = OpenNoteReconcileFacts(
                id: current.id,
                base: current.base,
                draft: current.draft,
                disk: disk,
                renamedTo: nil,
                isFocused: current.isFocused,
                editedDuringCycle: current.editVersion != cycleStartEditVersion
            )
            return apply(classify(facts), snapshot: current, effects: effects)
        }

        return .stale
    }

    private func apply(
        _ disposition: OpenNoteDisposition,
        snapshot: OpenNoteEditorSnapshot,
        effects: OpenNoteReconcileEffects
    ) -> OpenNoteReconcileResult {
        if !snapshot.isVisible {
            return .deferred
        }

        switch disposition {
        case .leave:
            hasDeferredAdopt = false
            if snapshot.draft != snapshot.base { effects.resumeDraftSave() }
        case .adopt(let content):
            hasDeferredAdopt = false
            effects.adopt(content)
        case .deferAdopt:
            hasDeferredAdopt = true
            return .deferred
        case .followRename(let toId):
            hasDeferredAdopt = false
            effects.followRename(toId)
        case .keepDraft(let base, let reason):
            hasDeferredAdopt = false
            effects.keepDraft(base, reason)
        case .close:
            hasDeferredAdopt = false
            effects.close()
        }
        return .applied
    }

    nonisolated private static func classifyWithEngine(
        _ facts: OpenNoteReconcileFacts
    ) -> OpenNoteDisposition {
        classifyOpenNote(
            facts: OpenNoteFacts(
                base: facts.base,
                draft: facts.draft,
                disk: facts.disk,
                renamedTo: facts.renamedTo,
                editorFocused: facts.isFocused,
                editedDuringCycle: facts.editedDuringCycle
            )
        )
    }
}

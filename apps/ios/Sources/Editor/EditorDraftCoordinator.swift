import Foundation

/// Admission control for fire-and-forget editor draft flushes. Identity
/// mutations advance a generation before suspending, so queued old-identity
/// flushes cannot recreate a deleted, renamed, or moved note.
@MainActor
final class EditorDraftCoordinator {
    struct Admission: Equatable {
        let id: String
        let generation: UInt64
    }

    struct IdentityMutation: Equatable {
        let id: String
        let generation: UInt64
    }

    private var generations: [String: UInt64] = [:]
    private var blocked: Set<String> = []

    func admit(_ id: String) -> Admission? {
        guard !blocked.contains(id) else { return nil }
        return Admission(id: id, generation: generations[id, default: 0])
    }

    func permits(_ admission: Admission) -> Bool {
        !blocked.contains(admission.id)
            && generations[admission.id, default: 0] == admission.generation
    }

    func beginIdentityMutation(_ id: String) -> IdentityMutation {
        let generation = generations[id, default: 0] + 1
        generations[id] = generation
        blocked.insert(id)
        return IdentityMutation(id: id, generation: generation)
    }

    func finishIdentityMutation(_ mutation: IdentityMutation, committed: Bool) {
        guard generations[mutation.id] == mutation.generation else { return }
        if !committed { blocked.remove(mutation.id) }
    }

    func reopen(_ id: String) {
        guard blocked.contains(id) else { return }
        generations[id, default: 0] += 1
        blocked.remove(id)
    }
}

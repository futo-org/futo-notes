import Foundation

/// Admission control for fire-and-forget editor draft flushes. Identity
/// mutations advance a generation before suspending, so queued old-identity
/// flushes cannot recreate a deleted, renamed, or moved note.
@MainActor
final class EditorDraftCoordinator {
    struct Admission: Equatable {
        let id: String
        let generation: UInt64
        let epoch: UInt64
    }

    struct IdentityMutation: Equatable {
        let id: String
        let generation: UInt64
        let epoch: UInt64
    }

    private var epoch: UInt64 = 0
    private var paused = false

    func beginReset() {
        paused = true
        epoch += 1
    }
    func endReset() {
        paused = false
        generations.removeAll()
        blocked.removeAll()
    }

    private var generations: [String: UInt64] = [:]
    private var blocked: Set<String> = []

    func admit(_ id: String) -> Admission? {
        guard !paused, !blocked.contains(id) else { return nil }
        return Admission(id: id, generation: generations[id, default: 0], epoch: epoch)
    }

    func permits(_ admission: Admission) -> Bool {
        !paused && admission.epoch == epoch && !blocked.contains(admission.id)
            && generations[admission.id, default: 0] == admission.generation
    }

    func beginIdentityMutation(_ id: String) -> IdentityMutation {
        let generation = generations[id, default: 0] + 1
        generations[id] = generation
        blocked.insert(id)
        return IdentityMutation(id: id, generation: generation, epoch: epoch)
    }

    func finishIdentityMutation(_ mutation: IdentityMutation, committed: Bool) {
        guard mutation.epoch == epoch, generations[mutation.id] == mutation.generation else {
            return
        }
        if !committed { blocked.remove(mutation.id) }
    }

    func reopen(_ id: String) {
        guard blocked.contains(id) else { return }
        generations[id, default: 0] += 1
        blocked.remove(id)
    }
}

import Testing

@testable import FutoNotesNative

@MainActor
@Suite("Editor draft coordinator")
struct EditorDraftCoordinatorTests {
    @Test("identity mutation rejects queued and newly submitted old drafts")
    func committedMutationBlocksOldIdentity() {
        let coordinator = EditorDraftCoordinator()
        let draft = coordinator.admit("note")!
        let mutation = coordinator.beginIdentityMutation("note")

        #expect(!coordinator.permits(draft))
        #expect(coordinator.admit("note") == nil)
        coordinator.finishIdentityMutation(mutation, committed: true)
        #expect(coordinator.admit("note") == nil)
    }

    @Test("failed mutation reopens with a new generation")
    func failedMutationReopens() {
        let coordinator = EditorDraftCoordinator()
        let stale = coordinator.admit("note")!
        let mutation = coordinator.beginIdentityMutation("note")

        coordinator.finishIdentityMutation(mutation, committed: false)

        let retry = coordinator.admit("note")
        #expect(retry != nil)
        #expect(!coordinator.permits(stale))
        #expect(coordinator.permits(retry!))
    }

    @Test("same-id reuse accepts only the new owner")
    func sameIdReuse() {
        let coordinator = EditorDraftCoordinator()
        let deletedOwner = coordinator.admit("note")!
        let deletion = coordinator.beginIdentityMutation("note")
        coordinator.finishIdentityMutation(deletion, committed: true)

        coordinator.reopen("note")

        let newOwner = coordinator.admit("note")
        #expect(newOwner != nil)
        #expect(!coordinator.permits(deletedOwner))
        #expect(coordinator.permits(newOwner!))
    }
}

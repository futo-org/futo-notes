import Foundation

extension NotesStore {
    /// A native editor's token remains valid until the store retires it during reset.
    func ownsDraft(_ token: UInt64?) -> Bool {
        guard !resetting else { return false }
        guard let token else { return true }
        return token > retiredDraftTokensThrough && token <= draftSeq
    }

    func claimDraftOwnership() -> UInt64 {
        draftSeq += 1
        return draftSeq
    }

    func releaseDraftOwnership(token: UInt64) {
        retirementHandlers[token] = nil
    }

    /// Pending native leaves stop synchronously before a reset wipes their vault.
    func whenRetired(token: UInt64, _ handler: @escaping @MainActor () -> Void) {
        guard token > retiredDraftTokensThrough else { return }
        retirementHandlers[token] = handler
    }
}

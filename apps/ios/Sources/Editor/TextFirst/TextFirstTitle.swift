import Foundation

/// The title field's rules, off the SwiftUI screen so what they act on is testable: the note
/// the editor is attached to now (which a peer's rename or a parked conflict may have changed
/// since the screen opened), never the id the screen was pushed with.
@MainActor
enum TextFirstTitle {
    enum Outcome: Equatable {
        /// A blank or illegal title keeps the current name and is not a failure.
        case unchanged
        case duplicate
        case renamed(String)
        case failed
    }

    /// Rename the attached note to the typed title through the Store's ordinary workflow,
    /// which retargets the live attachment; the engine's final id is adopted.
    static func rename(
        to raw: String, controller: TextFirstEditorController, store: NotesStore,
        ownerToken: UInt64
    ) async -> Outcome {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
            validateTitle(title: trimmed).allSatisfy({ $0.kind == "empty" })
        else { return .unchanged }
        let current = await controller.refreshIdentity()
        let parts = splitId(id: current)
        let sanitized = sanitizeTitle(title: trimmed)
        guard sanitized != parts.title else { return .unchanged }
        let target = makeId(folder: parts.folder, title: sanitized)
        let key = collisionKey(id: target)
        guard
            !store.notes.contains(where: { $0.id != current && collisionKey(id: $0.id) == key })
        else { return .duplicate }
        switch await store.rename(
            oldId: current, newId: target, draft: nil, ownerToken: ownerToken)
        {
        case .committed(let committed):
            controller.adoptIdentity(committed.id)
            controller.drainCoordinatedChanges()
            return .renamed(committed.id)
        case .failed:
            return .failed
        }
    }

    /// What the title field shows once the attachment moved from `previous` to `current`: the
    /// new title unless the user is part-way through typing a different one.
    static func fieldText(_ field: String, from previous: String, to current: String) -> String {
        field == splitId(id: previous).title ? splitId(id: current).title : field
    }
}

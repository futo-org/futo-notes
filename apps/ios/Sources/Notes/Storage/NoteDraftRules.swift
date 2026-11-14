import Foundation

/// An explicit snapshot passed to Rust's generic note-mutation workflows.
/// Native editor sessions retain and save their own document state.
struct PendingDraft: Equatable {
    let id: String
    let base: String
    let content: String
}

enum NoteMutationOutcome<Value> {
    case committed(Value)
    case failed
}

/// A committed rename or move: the note's final id, and — only when the
/// engine's relink rewrote the note's OWN links (a self-link) — the body it
/// left on disk. The editor saved a draft carrying the old link text and the
/// relink then changed it, so the editor's baseline must become this body, not
/// the draft (RC-71: the pre-relink baseline made the next save read the
/// relink as a peer's edit and park a conflict copy).
struct CommittedNote: Equatable {
    let id: String
    let relinkedBody: String?
}

import Foundation

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

/// What the editor holds after a rename/move whose relink rewrote its own body.
struct RelinkRebase: Equatable {
    /// The baseline: what the file now holds.
    let savedContent: String
    /// The editor's text.
    let content: String
    /// Push `content` into the live editor (selection-preserving adopt).
    let adoptIntoEditor: Bool
}

/// `flushed` is the draft the engine saved before it relinked; `live` is what
/// the editor holds now; `relinkedBody` is the file after the relink.
///
/// The file is the baseline whatever the editor holds. When nothing was typed
/// since the snapshot the editor adopts the file, so it shows the relinked link
/// text. A draft typed while the workflow committed is kept (the same
/// rebase-and-keep the desktop session applies): it still carries the old link
/// text and is saved over the file without a conflict copy (RC-70).
func rebasedOnRelink(flushed: String, live: String, relinkedBody: String?) -> RelinkRebase {
    guard let body = relinkedBody, body != flushed else {
        return RelinkRebase(savedContent: flushed, content: live, adoptIntoEditor: false)
    }
    guard live == flushed else {
        return RelinkRebase(savedContent: body, content: live, adoptIntoEditor: false)
    }
    return RelinkRebase(savedContent: body, content: body, adoptIntoEditor: true)
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

/// What the editor must record after a `flush_draft` that has already answered.
///
/// The flush is DURABLE by the time it returns a disposition, so what happens
/// next must not be conditional on the calling task still being live. The
/// debounced save is cancelled by the very next keystroke
/// (`EditorSession.schedule` cancels the previous `.save`), and gating the
/// baseline advance on that cancellation left `savedContent` behind disk — which
/// made the NEXT flush's `base` a lie, so the engine read this editor's own
/// earlier write as a peer edit and parked the draft as a conflict copy. Android
/// holds the same span uncancellable (`EditorSession.kt`,
/// `withContext(NonCancellable)`); a Swift `Task` body is not cancel-proof, so
/// the decision is pure and lives here instead. IDENTITY, not liveness, is the
/// only thing that may veto it.
enum SettledFlush: Equatable {
    /// Advance the baseline to the bytes that landed. Nothing else moved.
    case record(savedContent: String)
    /// The engine parked the draft: follow the copy AND advance the baseline, or
    /// the editor keeps writing at an id whose disk it no longer matches.
    case follow(parkedId: String, savedContent: String)
    /// Nothing landed, or it landed at an identity this editor has since left.
    case ignore
}

func settledFlush(
    disposition: FlushDisposition?,
    writtenContent: String,
    flushedId: String,
    currentId: String,
    sessionIsClosing: Bool
) -> SettledFlush {
    // A nil disposition is an I/O failure: nothing reached disk, so the existing
    // baseline still describes it and the draft stays dirty for a later retry.
    guard let disposition else { return .ignore }
    // The write landed at an id this editor no longer shows. Whoever owns the
    // new identity owns its baseline; recording here would describe another note.
    guard currentId == flushedId else { return .ignore }
    guard case .parkedConflict(let parkedId) = disposition else {
        return .record(savedContent: writtenContent)
    }
    // A destructive exit has latched. It owns identity until it finishes, so
    // record the bytes that landed but leave `noteId` where the exit left it.
    return sessionIsClosing
        ? .record(savedContent: writtenContent)
        : .follow(parkedId: parkedId, savedContent: writtenContent)
}

func shouldContinueDeleteAfterEditorWrite(
    hasPendingChanges: Bool,
    outcome: NoteMutationOutcome<Void>?
) -> Bool {
    if !hasPendingChanges { return true }
    guard let outcome else { return false }
    if case .committed = outcome { return true }
    return false
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

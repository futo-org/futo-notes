//! The one verdict on what happens to the open note after a sync cycle or an
//! external change.
//!
//! CONTEXT.md defines an open-note disposition as decided by ONE pure
//! classifier over gathered facts and applied by ONE executor with a single
//! re-validation. This module is that classifier. It reads nothing and writes
//! nothing: a shell gathers the facts (its editor state plus one disk read),
//! calls [`classify_open_note`], and renders the answer the way it already
//! renders a flush disposition (ADR-0001).
//!
//! Keeping the decision here is what stops the six-way branch from being
//! transcribed once per surface. It had been: twice on desktop with different
//! wording, once on iOS, and not at all on Android.

/// Everything the verdict depends on, gathered by the shell before it decides.
///
/// Gathering is asynchronous and the answer is not: read disk, snapshot the
/// editor, then classify. The executor re-validates that the editor is still
/// on the same note exactly once, when it applies the result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenNoteFacts {
    /// The content the editor last loaded or saved (CONTEXT.md: base).
    pub base: String,
    /// The editor's current buffer.
    pub draft: String,
    /// What the note holds on disk now, or `None` when it no longer exists.
    /// A shell that cannot distinguish "empty file" from "missing file" on a
    /// plain read must confirm existence before filling this in.
    pub disk: Option<String>,
    /// Where the engine relocated this note, when it reported a rename for it
    /// (`SyncSummary::renamed`). Shells follow reported renames; they never
    /// infer one from id patterns.
    pub renamed_to: Option<String>,
    /// The editor has focus or an IME composition in flight.
    pub editor_focused: bool,
    /// The user typed while the cycle that produced these facts was running,
    /// so the draft is newer than the decision that started it — even if the
    /// buffer happens to match the base again.
    pub edited_during_cycle: bool,
}

/// Why a draft is being kept, so each shell can say so in its own words.
/// Rust owns the decision; the shells own the wording (M15: cross-platform
/// tests never assert exact user-facing strings).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeepDraftReason {
    /// A peer deleted the note. The draft wins: the next flush recreates it at
    /// the original id (the flush verb's Recreated arm).
    PeerDeleted,
    /// Disk moved to something neither the base nor the draft. The baseline
    /// stays where it was, which is what leaves the next flush a true
    /// three-way decision the engine can park (#89: handing back the pulled
    /// bytes instead made it a fast-forward that overwrote the peer).
    Diverged,
    /// The draft and disk already agree; only the baseline was stale. Nothing
    /// to tell the user.
    Converged,
}

/// The single verdict (CONTEXT.md: open-note disposition).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenNoteDisposition {
    /// Nothing moved under the editor.
    Leave,
    /// Replace the buffer with `content` and rebase onto it.
    Adopt { content: String },
    /// An adopt is warranted but would interrupt the typist. Remember it and
    /// re-gather on the next blur.
    DeferAdopt,
    /// The engine relocated this note. Rebind the editor to `to_id`; the next
    /// pass classifies against the new id.
    FollowRename { to_id: String },
    /// Leave the buffer alone and set the baseline to `base`.
    ///
    /// `base` does two jobs with one value, because every shell assigns it to
    /// its `savedContent`: it tracks whether the editor is dirty, AND it is the
    /// expected-previous the next `flush_draft` is conditioned on (desktop
    /// `updateNote({ base })`, iOS/Android `PendingDraft(base:)`). So it must
    /// always be bytes the editor actually holds — never the peer's, however
    /// current those are on disk. [`KeepDraftReason`] says which value each arm
    /// carries and what breaks when it is the wrong one (#89).
    KeepDraft {
        base: String,
        reason: KeepDraftReason,
    },
    /// The note is gone and there is nothing to preserve.
    Close,
}

/// Decide what happens to the open note. Pure and total.
pub fn classify_open_note(facts: OpenNoteFacts) -> OpenNoteDisposition {
    // A reported rename outranks everything: until the editor is rebound, every
    // other fact describes an id the note no longer lives at — which is exactly
    // how a relocation used to read as a peer delete.
    if let Some(to_id) = facts.renamed_to {
        return OpenNoteDisposition::FollowRename { to_id };
    }

    // Two different questions, deliberately not one flag. "Is there unsaved
    // work?" decides whether a deleted note may close. "Would adopting
    // interrupt the user?" additionally covers a keystroke that landed while
    // the cycle ran — even one that happens to leave the buffer back at the
    // base, because the decision that started the cycle is already stale.
    let has_unsaved_work = facts.draft != facts.base;
    let draft_is_protected = has_unsaved_work || facts.edited_during_cycle;

    let Some(disk) = facts.disk else {
        // Persist-or-park: a draft is never dropped, so a deleted note with
        // unsaved work stays open and the next flush recreates it.
        return if has_unsaved_work {
            OpenNoteDisposition::KeepDraft {
                base: facts.base,
                reason: KeepDraftReason::PeerDeleted,
            }
        } else {
            OpenNoteDisposition::Close
        };
    };

    if disk == facts.draft {
        // Nothing to show either way; the only question is whether the
        // baseline still describes disk. A stale baseline is not cosmetic —
        // it is what let a later save clobber a peer's merged-in edit (F2).
        return if disk == facts.base {
            OpenNoteDisposition::Leave
        } else {
            OpenNoteDisposition::KeepDraft {
                base: disk,
                reason: KeepDraftReason::Converged,
            }
        };
    }

    if disk == facts.base {
        // Disk did not move; this cycle was about some other note. The draft
        // stands and its baseline is already correct.
        return OpenNoteDisposition::Leave;
    }

    if draft_is_protected {
        // Persist-or-park, and the baseline is what decides which. `flush_draft`
        // parks precisely when `current != base`, so keeping the PRE-pull base
        // is what parks this draft as a conflict copy and leaves the peer's
        // bytes on disk. Rebasing onto `disk` here — the one value that makes
        // `current == base` true — turned that park into a fast-forward write
        // and destroyed the peer's edit with no copy anywhere (#89). The
        // Converged arm above rebases for the opposite reason: there the draft
        // is already on disk, so only a stale baseline is left to repair (F2).
        return OpenNoteDisposition::KeepDraft {
            base: facts.base,
            reason: KeepDraftReason::Diverged,
        };
    }

    // A focused editor is never interrupted, on any host. Hosts differ in
    // whether their adopt can preserve the caret (the native shells'
    // `applyExternalContent` can, desktop's cannot), but the verdict does not
    // take that as an input: waiting for the next blur is the one answer
    // everywhere, so a caret never moves under a typist on any surface.
    if facts.editor_focused {
        return OpenNoteDisposition::DeferAdopt;
    }

    OpenNoteDisposition::Adopt { content: disk }
}

#[cfg(test)]
mod tests;

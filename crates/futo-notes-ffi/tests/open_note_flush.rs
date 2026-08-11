//! The seam between the two verbs a shell renders back to back: the open-note
//! verdict (`classify_open_note`) decides what happens to the buffer, and the
//! flush verb (`NoteStore::flush_draft`) commits it. Each verb is unit-tested in
//! its own crate; only here do they meet on a real vault, and only here can the
//! question that matters be asked — after the shell renders the verdict
//! verbatim, what is actually left on disk?
//!
//! Issue #89 lived exactly in this gap. Both verbs were internally consistent
//! and exhaustively tested, and the composition silently destroyed a peer's
//! edit: the verdict handed back the pulled disk content as the new baseline,
//! which is the one value that turns the flush's park arm into a fast-forward
//! write.

use std::fs;
use std::sync::Arc;

use futo_notes_ffi::{
    classify_open_note, FlushDisposition, KeepDraftReason, NoteStore, OpenNoteDisposition,
    OpenNoteFacts,
};

mod support;

use support::{path_string, TempTree};

const NOTE_ID: &str = "Shared note";
const BASE: &str = "# Shared note\n\nthe text both sides opened\n";
const DRAFT: &str = "# Shared note\n\nthe text both sides opened\n\nmy unsaved sentence\n";
const PEER: &str = "# Shared note\n\nthe text both sides opened\n\nthe peer's sentence\n";

/// A vault holding `NOTE_ID` with `content` (absent when `None` — a peer
/// deleted it), plus the store a shell would own for it.
fn vault(temp: &TempTree, content: Option<&str>) -> Arc<NoteStore> {
    let root = temp.path("vault");
    fs::create_dir_all(&root).unwrap();
    if let Some(content) = content {
        fs::write(root.join(format!("{NOTE_ID}.md")), content).unwrap();
    }
    NoteStore::new(path_string(&root))
}

/// What a shell knows before it asks: the note it loaded, what the user typed,
/// and what one disk read found.
fn facts(disk: Option<&str>) -> OpenNoteFacts {
    OpenNoteFacts {
        base: BASE.to_owned(),
        draft: DRAFT.to_owned(),
        disk: disk.map(str::to_owned),
        renamed_to: None,
        editor_focused: false,
        edited_during_cycle: false,
    }
}

/// THE #89 regression test. A peer edit landed under a dirty editor, so the
/// verdict is `KeepDraft { reason: Diverged }`; rendering it and flushing must
/// leave BOTH texts in the vault — the peer's edit at the note's own id, the
/// draft beside it as a conflict copy. Before the fix this assertion failed on
/// the peer's edit: the verdict's baseline made the flush a fast-forward and the
/// draft was written straight over it, with no copy anywhere in the vault.
#[test]
fn a_diverged_draft_parks_and_the_peer_edit_survives() {
    let temp = TempTree::new();
    let store = vault(&temp, Some(PEER));

    let disposition = classify_open_note(facts(Some(PEER)));
    let OpenNoteDisposition::KeepDraft {
        base: kept_base,
        reason: KeepDraftReason::Diverged,
    } = disposition
    else {
        panic!("a dirty draft against a peer edit must keep the draft, diverged");
    };

    // The shell renders the verdict verbatim (ADR-0001): the baseline it was
    // handed is the `base` its next flush passes down.
    let result = store
        .flush_draft(NOTE_ID.to_owned(), kept_base, DRAFT.to_owned())
        .expect("the flush must not fail on a readable vault");

    // Asserted before the disposition: what is on disk is the user-visible
    // stake, and naming it first makes a regression report the data loss
    // instead of an enum name.
    assert_eq!(
        store.read(NOTE_ID.to_owned()),
        PEER,
        "the peer's edit must survive at the note's own id"
    );
    let FlushDisposition::ParkedConflict { parked_id } = result.disposition else {
        panic!(
            "a draft flushed against a diverged note must park: {:?}",
            result.disposition
        );
    };
    assert_ne!(
        parked_id, NOTE_ID,
        "the conflict copy must be a different note, not the original id"
    );
    assert_eq!(
        store.read(parked_id),
        DRAFT,
        "the draft must survive as the conflict copy"
    );
}

/// The typist who ended a cycle back at the loaded text is protected for a
/// different reason (the decision that started the cycle is stale, not that
/// there is unsaved work), and reaches the same arm. Rebasing that draft was
/// the nastiest shape of #89: the buffer holds the PRE-pull text, so a
/// fast-forward flush would have written the peer's own note back to the text
/// the peer had just replaced.
#[test]
fn a_draft_edited_back_to_its_base_during_a_cycle_never_fast_forwards_over_the_peer() {
    let temp = TempTree::new();
    let store = vault(&temp, Some(PEER));

    let disposition = classify_open_note(OpenNoteFacts {
        draft: BASE.to_owned(),
        edited_during_cycle: true,
        ..facts(Some(PEER))
    });
    let OpenNoteDisposition::KeepDraft {
        base: kept_base,
        reason: KeepDraftReason::Diverged,
    } = disposition
    else {
        panic!("a draft edited during the cycle must be kept, diverged");
    };

    let result = store
        .flush_draft(NOTE_ID.to_owned(), kept_base, BASE.to_owned())
        .expect("the flush must not fail on a readable vault");

    assert_eq!(
        store.read(NOTE_ID.to_owned()),
        PEER,
        "the peer's edit must survive at the note's own id"
    );
    assert!(
        matches!(result.disposition, FlushDisposition::ParkedConflict { .. }),
        "the flush must park rather than restore the pre-pull text: {:?}",
        result.disposition
    );
}

/// The other half of the same rule, and the reason it cannot be stated as
/// "never rebase": when the draft and disk already agree, only the baseline was
/// stale, and rebasing onto disk is what stops a later save from clobbering the
/// peer's merged-in edit (F2). The flush then writes nothing at all.
#[test]
fn a_converged_draft_rebases_onto_disk_and_the_flush_writes_nothing() {
    let temp = TempTree::new();
    let store = vault(&temp, Some(DRAFT));

    let disposition = classify_open_note(facts(Some(DRAFT)));
    let OpenNoteDisposition::KeepDraft {
        base: kept_base,
        reason: KeepDraftReason::Converged,
    } = disposition
    else {
        panic!("a draft disk already holds must be kept, converged");
    };
    assert_eq!(
        kept_base, DRAFT,
        "a converged verdict must rebase onto what disk actually holds"
    );

    let result = store
        .flush_draft(NOTE_ID.to_owned(), kept_base, DRAFT.to_owned())
        .expect("the flush must not fail on a readable vault");

    assert_eq!(
        result.disposition,
        FlushDisposition::Converged,
        "nothing changed on disk, so the flush must not rewrite the note"
    );
    assert_eq!(store.read(NOTE_ID.to_owned()), DRAFT);
}

/// The third arm, unchanged by #89 and asserted here so the seam test covers
/// every `KeepDraft` reason: a peer deleted the note under a dirty editor, and
/// the draft wins by being recreated at its ORIGINAL id.
#[test]
fn a_peer_deleted_draft_is_recreated_at_its_original_id() {
    let temp = TempTree::new();
    let store = vault(&temp, None);

    let disposition = classify_open_note(facts(None));
    let OpenNoteDisposition::KeepDraft {
        base: kept_base,
        reason: KeepDraftReason::PeerDeleted,
    } = disposition
    else {
        panic!("a dirty draft whose note was deleted must be kept, peer-deleted");
    };

    let result = store
        .flush_draft(NOTE_ID.to_owned(), kept_base, DRAFT.to_owned())
        .expect("the flush must not fail on a readable vault");

    assert_eq!(result.disposition, FlushDisposition::Recreated);
    assert_eq!(store.read(NOTE_ID.to_owned()), DRAFT);
}

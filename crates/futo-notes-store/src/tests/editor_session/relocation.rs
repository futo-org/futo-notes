//! An attached note moved outside the store (a sync relocation reports it
//! through `futo_notes_core::files::note_moved`), released without a save, or
//! read back from disk.
use super::*;
use futo_notes_core::files::{note_moved, vault_fs, vault_mutation_guard};
use std::sync::atomic::{AtomicUsize, Ordering};

/// What sync's `move_mapped_note` does to a mapped note the server renamed:
/// move it and report the move under one vault-guard hold, then write the
/// pulled bytes at the new name.
fn pull_rename(root: &std::path::Path, from: &str, to: &str, pulled: &str) {
    {
        let _vault = vault_mutation_guard().unwrap();
        let (from, to) = (format!("{from}.md"), format!("{to}.md"));
        assert!(vault_fs::move_no_replace_strict(root, &from, &to).unwrap());
        note_moved(root, &from, &to);
    }
    let _vault = vault_mutation_guard().unwrap();
    vault_fs::write_atomic(root, &format!("{to}.md"), pulled.as_bytes()).unwrap();
}

#[test]
fn a_pulled_rename_moves_the_attachment_and_its_next_save_writes_the_new_id() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "base").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    let moves = Arc::new(AtomicUsize::new(0));
    let heard = moves.clone();
    editor.on_moved(move || {
        heard.fetch_add(1, Ordering::SeqCst);
    });
    editor.replace(Revision(0), range(4, 4), " draft").unwrap();

    pull_rename(&root.0, "old", "new", "base");

    assert_eq!(editor.id(), "new");
    assert_eq!(moves.load(Ordering::SeqCst), 1);
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    assert_eq!(store.read("new").unwrap(), "base draft");
    // Saved to the id it left, the draft was recreated there: a ghost that
    // synced to every peer and undid their rename.
    assert!(!root.0.join("old.md").exists());
    // The lease moved with it: the old id is free, the new one is held.
    store.create("", "old", "unrelated").unwrap();
    assert!(store
        .save_unattached(Some("new"), "new", "x", None)
        .is_err());
}

#[test]
fn a_pulled_rename_with_a_peer_edit_parks_the_draft_instead_of_overwriting_it() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "base").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(4, 4), " draft").unwrap();

    pull_rename(&root.0, "old", "new", "base, edited by the peer");

    let parked = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = parked.disposition else {
        panic!("expected a park, got {parked:?}");
    };
    assert_eq!(editor.id(), parked_id);
    assert_eq!(store.read(&parked_id).unwrap(), "base draft");
    assert_eq!(store.read("new").unwrap(), "base, edited by the peer");
    assert!(!root.0.join("old.md").exists());
}

#[test]
fn a_store_move_wakes_the_attachments_host() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "base").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    let moves = Arc::new(AtomicUsize::new(0));
    let heard = moves.clone();
    editor.on_moved(move || {
        heard.fetch_add(1, Ordering::SeqCst);
    });
    store.move_note("old", "Archive").unwrap();
    assert_eq!(editor.id(), "Archive/old");
    assert_eq!(moves.load(Ordering::SeqCst), 1);
}

#[test]
fn discard_releases_the_attachment_without_writing() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "base").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(4, 4), " draft").unwrap();
    editor.discard();
    assert_eq!(store.read("old").unwrap(), "base");
    // Released: the note saves like any unattached note again.
    store
        .save_unattached(Some("old"), "old", "after", None)
        .unwrap();
}

#[test]
fn reload_saves_then_reads_the_note_back_keeping_its_lease() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "base").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(4, 4), " draft").unwrap();
    editor.reload(false).unwrap();
    assert_eq!(editor.source_text(), "base draft");
    assert_eq!(editor.save_status().saved, editor.revision());

    // An outside change to a clean draft is what a reload adopts.
    std::fs::write(root.0.join("old.md"), "outside").unwrap();
    assert_eq!(
        editor.reload(false).unwrap().unwrap().disposition,
        FlushDisposition::Converged
    );
    assert_eq!(editor.source_text(), "outside");
    assert!(store
        .save_unattached(Some("old"), "old", "x", None)
        .is_err());
}

#[test]
fn a_reload_whose_save_parks_reads_the_copy_it_holds() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "base").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(4, 4), " draft").unwrap();
    std::fs::write(root.0.join("old.md"), "outside").unwrap();
    let parked = editor.reload(false).unwrap().unwrap();
    assert!(matches!(
        parked.disposition,
        FlushDisposition::ParkedConflict { .. }
    ));
    assert_ne!(editor.id(), "old");
    assert_eq!(editor.source_text(), "base draft");
    assert_eq!(store.read("old").unwrap(), "outside");
}

#[test]
fn a_title_rename_lands_in_the_folder_the_note_is_in_when_it_runs() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "Roadmap", "base").unwrap();
    let mut editor = store.open_editor("Roadmap").unwrap();
    store.move_note("Roadmap", "Archive").unwrap();
    let renamed = editor.rename_title("Plan").unwrap();
    assert_eq!(renamed.final_id, "Archive/Plan");
    assert_eq!(store.read("Archive/Plan").unwrap(), "base");
    // Sanitized as a title is (M2: only what the filesystem cannot hold changes).
    assert_eq!(editor.rename_title("a/b").unwrap().final_id, "Archive/ab");
}

//! A rename of the attached note: where its draft is saved, and what the page adopts.
use super::*;

#[test]
fn rename_while_dirty_keeps_the_draft_and_saves_under_the_new_id() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "base").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(4, 4), "!").unwrap();
    store.rename("old", "new").unwrap();
    assert_eq!(editor.id(), "new");
    assert_eq!(editor.source_text(), "base!");
    assert_eq!(store.read("new").unwrap(), "base");
    editor.checkpoint().unwrap();
    assert_eq!(store.read("new").unwrap(), "base!");
    assert_eq!(store.read_existing("old").unwrap(), None);
}

#[test]
fn rename_while_clean_adopts_the_rewritten_links_as_one_undo_step() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "[[old]] tail").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    store.rename("old", "long name").unwrap();
    assert_eq!(editor.id(), "long name");
    assert_eq!(editor.source_text(), "[[long name]] tail");
    assert_eq!(editor.take_coordinated_changes().unwrap().len(), 1);
    // Adopting the rewrite left the draft equal to the file: nothing to save.
    assert!(editor.save_delay().is_none());
    assert_eq!(editor.checkpoint().unwrap().mutation, None);
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[old]] tail");
    assert!(editor.undo(editor.revision()).unwrap().is_none());
}

#[test]
fn editor_rename_saves_the_draft_under_the_new_id_in_one_step() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "base").unwrap();
    store.create("", "linker", "see [[old]]").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(4, 4), "!").unwrap();
    let renamed = editor.rename_title("new").unwrap();
    assert_eq!(
        (renamed.final_id.as_str(), renamed.parked_id),
        ("new", None)
    );
    assert_eq!(renamed.mutation.removed, ["old"]);
    assert_eq!(renamed.mutation.relinked, ["linker"]);
    assert_eq!(store.read_existing("old").unwrap(), None);
    assert_eq!(store.read("new").unwrap(), "base!");
    assert_eq!(store.read("linker").unwrap(), "see [[new]]");
    // The attachment, its lease and its baseline follow: nothing is left to save.
    assert_eq!(editor.id(), "new");
    assert!(store.open_editor("new").is_err());
    assert!(editor.save_delay().is_none());
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Converged
    );
    editor.replace(Revision(1), range(5, 5), "?").unwrap();
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    assert_eq!(store.read("new").unwrap(), "base!?");
}

#[test]
fn editor_rename_over_a_changed_note_parks_the_draft_at_the_destination() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "base").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(4, 4), "!").unwrap();
    store.write("plain", "peer", None).unwrap();
    let renamed = editor.rename_title("renamed").unwrap();
    let parked = renamed.parked_id.clone().expect("a stale draft parks");
    assert!(parked.starts_with("renamed (conflict "), "{parked}");
    assert_eq!(renamed.final_id, parked);
    assert_eq!(renamed.mutation.final_id.as_deref(), Some(parked.as_str()));
    assert_eq!(store.read("plain").unwrap(), "peer");
    assert_eq!(store.read(&parked).unwrap(), "base!");
    assert_eq!(store.read_existing("renamed").unwrap(), None);
    // The editor follows the copy; the peer's note is free.
    assert_eq!(editor.id(), parked);
    drop(store.open_editor("plain").unwrap());
    editor.replace(Revision(1), range(5, 5), "?").unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(store.read(&parked).unwrap(), "base!?");
    assert_eq!(store.read("plain").unwrap(), "peer");
}

#[test]
fn editor_rename_keeps_a_relink_the_page_has_not_adopted() {
    use futo_notes_editor::SessionToken;
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "other", "x").unwrap();
    store.create("", "plain", "[[other]]").unwrap();
    let mut host = store
        .open_editor("plain")
        .unwrap()
        .into_portable_host(SessionToken(9))
        .unwrap();
    // The portable page is offered the rewrite; until it adopts it the file
    // is ahead of the draft.
    store.rename("other", "moved").unwrap();
    assert_eq!(store.read("plain").unwrap(), "[[moved]]");
    host.rename_title("renamed").unwrap();
    assert_eq!(store.read("renamed").unwrap(), "[[moved]]");
}

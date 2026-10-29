use super::*;
use futo_notes_editor::InputAction;

#[test]
fn adopted_self_relink_keeps_disjoint_user_history_and_mapped_caret() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create("", "old", "[[old]] tail").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor
        .select_with_affinity(Revision(0), range(12, 12), Affinity::Backward)
        .unwrap();
    editor
        .replace_action(Revision(0), range(12, 12), "!", InputAction::Isolated)
        .unwrap();
    editor.checkpoint().unwrap();
    let mutation = store.rename("old", "long name").unwrap();
    assert_eq!(mutation.relinked, ["long name"]);
    assert_eq!(editor.source_text(), "[[long name]] tail!");
    assert_eq!(editor.selection(), range(19, 19));
    let undo = editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[long name]] tail");
    assert_eq!(undo.selection, range(18, 18));
    assert_eq!(undo.affinity, Affinity::Backward);
    let redo = editor.redo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[long name]] tail!");
    assert_eq!(redo.selection, range(19, 19));
    assert_eq!(redo.affinity, Affinity::Backward);
}

#[test]
fn adopted_relink_preserves_a_user_action_overlapping_the_rewritten_target() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create("", "old", "[[else]]").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor
        .select_with_affinity(Revision(0), range(2, 6), Affinity::Forward)
        .unwrap();
    editor
        .replace_action(Revision(0), range(2, 6), "old", InputAction::Isolated)
        .unwrap();
    editor.checkpoint().unwrap();
    store.rename("old", "long name").unwrap();
    assert_eq!(editor.source_text(), "[[long name]]");
    let undo = editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[else]]");
    assert_eq!(undo.selection, range(2, 6));
    assert_eq!(undo.affinity, Affinity::Forward);
    let redo = editor.redo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[long name]]");
    assert_eq!(redo.selection, range(11, 11));
}

#[test]
fn adopted_relink_keeps_history_whose_user_edit_replaced_the_entire_source() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create("", "old", "[[old]]").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor
        .select_with_affinity(Revision(0), range(0, 7), Affinity::Forward)
        .unwrap();
    editor
        .replace_action(
            Revision(0),
            range(0, 7),
            "[[old]] plus",
            InputAction::Isolated,
        )
        .unwrap();
    editor.checkpoint().unwrap();
    store.rename("old", "long name").unwrap();
    assert_eq!(editor.source_text(), "[[long name]] plus");
    let undo = editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[long name]]");
    assert_eq!(undo.selection, range(0, 13));
    editor.redo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[long name]] plus");
}

#[test]
fn identity_only_rename_keeps_historical_only_links_and_redo_verbatim() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create("", "old", "[[old]]").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor
        .replace_action(Revision(0), range(0, 7), "plain", InputAction::Isolated)
        .unwrap();
    editor.checkpoint().unwrap();
    let mutation = store.rename("old", "long name").unwrap();
    assert!(mutation.relinked.is_empty());
    assert!(editor.take_coordinated_changes().unwrap().is_empty());
    assert_eq!(editor.revision(), Revision(1));
    editor.undo(Revision(1)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[old]]");
    editor.redo(Revision(2)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "plain");
}

#[test]
fn escaped_relink_follows_existing_text_rule_and_preserves_escaped_history() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create("", "old", "\\[[old]]").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor
        .replace_action(Revision(0), range(7, 7), "!", InputAction::Isolated)
        .unwrap();
    editor.checkpoint().unwrap();
    store.rename("old", "long name").unwrap();
    assert_eq!(editor.source_text(), "\\[[long name]]!");
    editor.undo(Revision(2)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "\\[[long name]]");
    editor.redo(Revision(3)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "\\[[long name]]!");
}

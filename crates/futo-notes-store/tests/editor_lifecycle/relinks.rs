use super::*;
use futo_notes_editor::InputAction;
use futo_notes_store::StoreEditorSession;

/// A clean draft with one user edit whose own-action rename rewrites its link.
fn renamed_draft(store: &LocalNoteStore) -> StoreEditorSession<'_> {
    store.create("", "old", "[[old]] tail\n").unwrap();
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
    editor
}

#[test]
fn an_adopted_relink_is_one_undo_step_above_untouched_history() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    let mut editor = renamed_draft(&store);
    assert_eq!(editor.take_coordinated_changes().unwrap().len(), 1);
    assert_eq!(editor.source_text(), "[[long name]] tail!\n");
    assert_eq!(editor.selection(), range(19, 19));
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[old]] tail!\n");
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[old]] tail\n");
    editor.redo(editor.revision()).unwrap().unwrap();
    editor.redo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[long name]] tail!\n");
    assert!(editor.redo(editor.revision()).unwrap().is_none());
}

#[test]
fn an_adopted_relink_and_its_undo_save_exactly() {
    for undo in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let store = LocalNoteStore::new(root.path().to_owned());
        let mut editor = renamed_draft(&store);
        if undo {
            editor.undo(editor.revision()).unwrap().unwrap();
        }
        let expected = if undo {
            "[[old]] tail!\n"
        } else {
            "[[long name]] tail!\n"
        };
        editor.checkpoint().unwrap();
        assert_eq!(store.read("long name").unwrap(), expected);
        drop(editor);
        assert_eq!(
            store.open_editor("long name").unwrap().source_text(),
            expected
        );
    }
}

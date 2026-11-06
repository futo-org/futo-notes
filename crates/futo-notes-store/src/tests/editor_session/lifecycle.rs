use super::*;

struct OccupyDestination(std::path::PathBuf);
impl BeforeWrite for OccupyDestination {
    fn before_write(&self, changes: &[FileChange]) {
        if changes
            .iter()
            .any(|change| matches!(change, FileChange::Renamed { .. }))
        {
            // This hook is an external filesystem input below the workflow.
            std::fs::write(self.0.join("new.md"), "external").unwrap();
        }
    }
}

#[test]
fn failed_rename_leaves_a_backlinked_attachment_editable_and_saveable() {
    let root = TestRoot::new();
    let store = LocalNoteStore::with_before_write(
        root.0.clone(),
        Arc::new(OccupyDestination(root.0.clone())),
    );
    store.create("", "old", "target").unwrap();
    store.create("", "plain", "[[old]]").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(7, 7), "!").unwrap();
    assert!(store.rename("old", "new").is_err());
    editor.replace(Revision(1), range(8, 8), "?").unwrap();
    assert_eq!(editor.source_text(), "[[old]]!?\n");
    editor.checkpoint().unwrap();
    assert_eq!(store.read("old").unwrap(), "target\n");
    assert_eq!(store.read("new").unwrap(), "external");
    assert_eq!(store.read("plain").unwrap(), "[[old]]!?\n");
}

#[test]
fn failed_delete_leaves_the_attachment_untouched() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "old").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(3, 3), " draft").unwrap();
    assert!(store
        .delete_with("old", |_| Err("delete refused".into()))
        .is_err());
    assert_eq!(editor.source_text(), "old draft\n");
    editor.replace(Revision(1), range(9, 9), "!").unwrap();
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    assert_eq!(store.read("old").unwrap(), "old draft!\n");
    assert_eq!(store.snapshot().notes.len(), 1);
}

#[test]
fn rename_keeps_the_draft_and_the_next_save_lands_under_the_new_id() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "old").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(3, 3), " draft").unwrap();
    let mutation = store.rename("old", "new").unwrap();
    assert_eq!(mutation.final_id.as_deref(), Some("new"));
    assert_eq!(editor.id(), "new");
    assert_eq!(editor.source_text(), "old draft\n");
    assert_eq!(store.read("new").unwrap(), "old\n");
    editor.undo(Revision(1)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "old\n");
    editor.redo(Revision(2)).unwrap().unwrap();
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    assert_eq!(store.read_existing("old").unwrap(), None);
    assert_eq!(store.read("new").unwrap(), "old draft\n");
}

use futo_notes_editor::{Affinity, DisplayOffset, DisplayRange, Revision};
use futo_notes_store::{FlushDisposition, LocalNoteStore};

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[test]
fn global_rename_retargets_dirty_attachment_and_preserves_history() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create("", "old", "__日__\r\n").unwrap();
    store.create("", "wanted", "occupied\n").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor
        .select_with_affinity(Revision(0), range(3, 3), Affinity::Backward)
        .unwrap();
    editor.replace(Revision(0), range(3, 3), "😀").unwrap();
    let mutation = store.rename("old", "wanted").unwrap();
    assert_eq!(mutation.final_id.as_deref(), Some("wanted-2"));
    assert_eq!(editor.id(), "wanted-2");
    assert_eq!(editor.source_text(), "__日😀__\r\n");
    assert_eq!(editor.revision(), Revision(1));
    assert_eq!(editor.selection(), range(7, 7));
    editor.undo(Revision(1)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "__日__\r\n");
    editor.redo(Revision(2)).unwrap().unwrap();
    editor.replace(Revision(3), range(7, 7), "!").unwrap();
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    assert_eq!(store.read_existing("old").unwrap(), None);
    assert_eq!(store.read("wanted-2").unwrap(), "__日😀!__\r\n");
    assert_eq!(store.read("wanted").unwrap(), "occupied\n");
    drop(editor);
    assert_eq!(
        store.open_editor("wanted-2").unwrap().source_text(),
        "__日😀!__\r\n"
    );
}

#[test]
fn delete_fences_the_old_attachment_even_after_intentional_recreation() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create("", "note", "old\n").unwrap();
    let mut old = store.open_editor("note").unwrap();
    old.replace(Revision(0), range(3, 3), " draft").unwrap();
    let mutation = store.delete("note").unwrap();
    assert_eq!(mutation.removed, ["note"]);
    store.create("", "note", "new incarnation\n").unwrap();
    let new = store.open_editor("note").unwrap();
    assert_eq!(new.source_text(), "new incarnation\n");
    assert!(old.replace(Revision(1), range(9, 9), "!").is_err());
    assert!(old.undo(Revision(1)).is_err());
    assert!(old.checkpoint().is_err());
    assert_eq!(old.source_text(), "old draft\n");
    drop(new);
    drop(old);
    let mut reopened = store.open_editor("note").unwrap();
    assert_eq!(reopened.source_text(), "new incarnation\n");
    assert_eq!(reopened.checkpoint().unwrap().mutation, None);
    assert_eq!(store.read("note").unwrap(), "new incarnation\n");
}

#[path = "editor_lifecycle/folders.rs"]
mod folders;
#[path = "editor_lifecycle/relinks.rs"]
mod relinks;

#[test]
fn saving_an_emptied_note_keeps_empty_content_distinct_from_an_absent_note() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    assert!(store.open_editor("never attached").is_err());
    assert_eq!(store.read_existing("never attached").unwrap(), None);
    assert!(store.snapshot().notes.is_empty());
    store.create("", "emptied", "body\n").unwrap();
    {
        let mut editor = store.open_editor("emptied").unwrap();
        editor.replace(Revision(0), range(0, 5), "").unwrap();
        assert_eq!(editor.source_text(), "");
        assert_eq!(store.read("emptied").unwrap(), "body\n");
        assert_eq!(
            editor.checkpoint().unwrap().disposition,
            FlushDisposition::Wrote
        );
    }
    assert_eq!(store.read_existing("emptied").unwrap(), Some(String::new()));
    assert_eq!(store.open_editor("emptied").unwrap().source_text(), "");
    assert_eq!(store.read_existing("never attached").unwrap(), None);
    assert_eq!(store.snapshot().notes.len(), 1);
}

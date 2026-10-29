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
    store.create("", "wanted", "occupied").unwrap();
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
    assert_eq!(store.read("wanted").unwrap(), "occupied");
    drop(editor);
    assert_eq!(
        store.open_editor("wanted-2").unwrap().source_text(),
        "__日😀!__\r\n"
    );
}

#[test]
fn committed_delete_fences_old_attachment_even_after_intentional_recreation() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create("", "note", "old").unwrap();
    let mut old = store.open_editor("note").unwrap();
    old.replace(Revision(0), range(3, 3), " draft").unwrap();
    let mutation = store.delete("note").unwrap();
    assert_eq!(mutation.removed, ["note"]);
    store.create("", "note", "new incarnation").unwrap();
    let new = store.open_editor("note").unwrap();
    assert_eq!(new.source_text(), "new incarnation");
    assert!(old.replace(Revision(1), range(9, 9), "!").is_err());
    assert!(old.undo(Revision(1)).is_err());
    assert!(old.flush_recovery().is_err());
    assert!(old.resume_recovery().is_err());
    assert!(old.checkpoint().is_err());
    assert_eq!(old.source_text(), "old draft");
    drop(new);
    drop(old);
    let mut reopened = store.open_editor("note").unwrap();
    assert_eq!(reopened.source_text(), "new incarnation");
    assert_eq!(reopened.checkpoint().unwrap().mutation, None);
    assert_eq!(store.read("note").unwrap(), "new incarnation");
}

#[path = "editor_lifecycle/relinks.rs"]
mod relinks;

#[test]
fn draft_identity_workflow_keeps_matching_attachment_without_false_replacement_conflict() {
    for peer in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let store = LocalNoteStore::new(root.path().to_owned());
        store.create("", "old", "base").unwrap();
        store.create("", "links", "[[old]]").unwrap();
        let mut editor = store.open_editor("old").unwrap();
        editor.replace(Revision(0), range(4, 4), " draft").unwrap();
        if peer {
            store.write("old", "peer", None).unwrap();
        }
        let mutation = store
            .save_draft_as("old", "wanted", "base", "base draft")
            .unwrap();
        let final_id = mutation.final_id.unwrap();
        assert_eq!(editor.id(), final_id);
        assert_eq!(editor.source_text(), "base draft");
        assert_eq!(
            editor.checkpoint().unwrap().disposition,
            FlushDisposition::Converged
        );
        if peer {
            assert!(final_id.starts_with("wanted (conflict "));
            assert_eq!(store.read("old").unwrap(), "peer");
            assert_eq!(store.read("links").unwrap(), "[[old]]");
        } else {
            assert_eq!(final_id, "wanted");
            assert_eq!(store.read_existing("old").unwrap(), None);
            assert_eq!(store.read("links").unwrap(), "[[wanted]]");
        }
        editor.undo(Revision(1)).unwrap().unwrap();
        assert_eq!(editor.source_text(), "base");
        editor.redo(Revision(2)).unwrap().unwrap();
        editor.checkpoint().unwrap();
        assert_eq!(store.read(&final_id).unwrap(), "base draft");
        assert_eq!(store.snapshot().notes.len(), if peer { 3 } else { 2 });
    }
}

#[test]
fn move_draft_collision_then_new_input_stays_on_the_atomic_workflows_final_identity() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create("", "old", "base").unwrap();
    store.create("folder", "old", "occupied").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(4, 4), " draft").unwrap();
    let mutation = store
        .move_draft("old", "folder", "base", "base draft")
        .unwrap();
    assert_eq!(mutation.final_id.as_deref(), Some("folder/old-2"));
    assert_eq!(editor.id(), "folder/old-2");
    editor.replace(Revision(1), range(10, 10), "!").unwrap();
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    assert_eq!(store.read("folder/old-2").unwrap(), "base draft!");
    assert_eq!(store.read("folder/old").unwrap(), "occupied");
    assert_eq!(store.read_existing("old").unwrap(), None);
    assert_eq!(store.snapshot().notes.len(), 2);
}

#[test]
fn delete_fences_both_pending_source_and_foreign_destination_attachments() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create("", "new", "foreign").unwrap();
    {
        let mut foreign = store.open_editor("new").unwrap();
        foreign.replace(Revision(0), range(7, 7), " draft").unwrap();
    }
    std::fs::remove_file(root.path().join("new.md")).unwrap();
    store.create("", "old", "base").unwrap();
    let mut old = store.open_editor("old").unwrap();
    old.replace(Revision(0), range(4, 4), " draft").unwrap();
    let moved = store.rename("old", "new").unwrap();
    assert_eq!(moved.final_id.as_deref(), Some("new"));
    assert!(old.recovery_status().paused);
    let mut foreign = store.open_editor("new").unwrap();
    assert_eq!(foreign.source_text(), "foreign draft");
    store.delete("new").unwrap();
    store.create("", "new", "fresh").unwrap();
    assert!(matches!(
        old.resume_recovery(),
        Err(futo_notes_store::EditorStoreError::SessionDeleted)
    ));
    assert!(matches!(
        foreign.checkpoint(),
        Err(futo_notes_store::EditorStoreError::SessionDeleted)
    ));
    let mut fresh = store.open_editor("new").unwrap();
    assert_eq!(fresh.source_text(), "fresh");
    fresh.checkpoint().unwrap();
    drop(fresh);
    drop(foreign);
    drop(old);
    for _ in 0..2 {
        assert!(store.open_editor("old").is_err());
        assert_eq!(store.open_editor("new").unwrap().source_text(), "fresh");
        assert_eq!(store.snapshot().notes.len(), 1);
    }
}

#[test]
fn switching_detached_drafts_keeps_empty_content_distinct_from_an_absent_note() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    assert!(store.open_editor("never attached").is_err());
    assert_eq!(store.read_existing("never attached").unwrap(), None);
    assert!(store.snapshot().notes.is_empty());
    store.create("", "emptied", "body").unwrap();
    store.create("", "other", "other").unwrap();
    {
        let mut editor = store.open_editor("emptied").unwrap();
        editor.replace(Revision(0), range(0, 4), "").unwrap();
        editor.flush_recovery().unwrap();
        assert_eq!(editor.source_text(), "");
        assert_eq!(store.read("emptied").unwrap(), "body");
    }
    {
        let mut editor = store.open_editor("other").unwrap();
        editor.replace(Revision(0), range(5, 5), "!").unwrap();
    }
    {
        let mut editor = store.open_editor("emptied").unwrap();
        assert_eq!(editor.source_text(), "");
        assert_eq!(editor.revision(), Revision(1));
        assert_eq!(
            editor.checkpoint().unwrap().disposition,
            FlushDisposition::Wrote
        );
    }
    let mut other = store.open_editor("other").unwrap();
    assert_eq!(other.source_text(), "other!");
    other.checkpoint().unwrap();
    assert_eq!(store.read_existing("emptied").unwrap(), Some(String::new()));
    assert_eq!(store.read("other").unwrap(), "other!");
    assert_eq!(store.read_existing("never attached").unwrap(), None);
    assert_eq!(store.snapshot().notes.len(), 2);
}

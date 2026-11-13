use super::*;

#[test]
fn every_identity_workflow_preserves_the_attached_draft_and_exact_history() {
    for (action, expected) in [
        ("case note", "folder/OLD"),
        ("move note", "dest/old"),
        ("rename folder", "renamed/old"),
        ("case folder", "FOLDER/old"),
        ("move folder", "archive/folder/old"),
        ("delete folder", "old-2"),
    ] {
        let root = tempfile::tempdir().unwrap();
        let store = LocalNoteStore::new(root.path().to_owned());
        store.create("folder", "old", "__日__\r\n").unwrap();
        store.create("", "old", "occupied").unwrap();
        store.create_folder("dest").unwrap();
        store.create_folder("archive").unwrap();
        let mut editor = store.open_editor("folder/old").unwrap();
        editor
            .select_with_affinity(Revision(0), range(3, 3), Affinity::Backward)
            .unwrap();
        editor.replace(Revision(0), range(3, 3), "😀").unwrap();
        let mutation = match action {
            "case note" => store.rename("folder/old", "folder/OLD"),
            "move note" => store.move_note("folder/old", "dest"),
            "rename folder" => store.rename_folder("folder", "renamed"),
            "case folder" => store.rename_folder("folder", "FOLDER"),
            "move folder" => store.move_folder("folder", "archive"),
            "delete folder" => store.delete_folder("folder"),
            _ => unreachable!(),
        }
        .unwrap();
        assert_eq!(mutation.renamed.len(), 1, "{action}");
        assert_eq!(mutation.renamed[0].from, "folder/old");
        assert_eq!(mutation.renamed[0].to, expected);
        assert_eq!(editor.id(), expected);
        assert_eq!(editor.source_text(), "__日😀__\r\n");
        assert_eq!(editor.revision(), Revision(1));
        assert!(editor.take_coordinated_changes().unwrap().is_empty());
        let undo = editor.undo(Revision(1)).unwrap().unwrap();
        assert_eq!(editor.source_text(), "__日__\r\n");
        assert_eq!(undo.selection, range(3, 3));
        assert_eq!(undo.affinity, Affinity::Backward);
        let redo = editor.redo(Revision(2)).unwrap().unwrap();
        assert_eq!(editor.source_text(), "__日😀__\r\n");
        assert_eq!(redo.selection, range(7, 7));
        assert_eq!(redo.affinity, Affinity::Backward);
        editor.replace(Revision(3), range(7, 7), "!").unwrap();
        assert_eq!(
            editor.checkpoint().unwrap().disposition,
            FlushDisposition::Wrote,
            "{action}"
        );
        assert_eq!(store.read(expected).unwrap(), "__日😀!__\r\n");
        assert_eq!(store.read("old").unwrap(), "occupied");
        drop(editor);
        assert_eq!(
            store.open_editor(expected).unwrap().source_text(),
            "__日😀!__\r\n"
        );
        assert_eq!(store.snapshot().notes.len(), 2);
    }
}

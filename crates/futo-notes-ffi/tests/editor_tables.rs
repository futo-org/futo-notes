mod support;
use futo_notes_ffi::{
    EditorByteRange, EditorTableCommand, EditorTableKey, EditorTableOutcome, NoteStore,
};
use support::{path_string, TempTree};

#[test]
fn native_table_cells_keys_and_commands_recover_exact_source() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let path = path_string(&tree.path("vault"));
    let store = NoteStore::new(path.clone());
    store
        .create_note(
            "grid".into(),
            "".into(),
            "| a | b |\r\n| --- | --: |\r\n| c | d |\r\n".into(),
        )
        .unwrap();
    let session = store.open_editor("grid".into()).unwrap();
    let table = session
        .inspect_table(0, EditorByteRange { start: 0, end: 0 })
        .unwrap()
        .unwrap();
    assert_eq!((table.columns, table.rows.len()), (2, 2));
    let a = &table.rows[0][0].content;
    let caret = EditorByteRange {
        start: a.end,
        end: a.end,
    };
    session
        .replace_in_cell(0, caret, "x|y".into())
        .unwrap()
        .unwrap();
    let at = EditorByteRange { start: 2, end: 2 };
    let Some(EditorTableOutcome::Selected { change }) =
        session.table_key(1, EditorTableKey::Tab).unwrap()
    else {
        panic!("Tab moves");
    };
    assert_eq!(change.revision, 1);
    session
        .table_command(1, at, EditorTableCommand::InsertColumnRight)
        .unwrap()
        .unwrap();
    session.flush_recovery().unwrap();
    drop(session);
    drop(store);
    let store = NoteStore::new(path);
    let session = store.open_editor("grid".into()).unwrap();
    assert_eq!(
        session.source_text().unwrap(),
        "| ax\\|y |  | b |\r\n| --- | --- | --: |\r\n| c |  | d |\r\n"
    );
}

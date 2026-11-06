mod support;
use futo_notes_ffi::{
    EditorByteRange, EditorTableCommand, EditorTableKey, EditorUtf16Range, NoteStore,
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
    let display = session.display_text().unwrap();
    let all = session
        .inspect_tables(
            0,
            EditorByteRange {
                start: 0,
                end: display.len() as u64,
            },
        )
        .unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].display, table.display);
    let line =
        |range: &EditorByteRange| display[range.start as usize..range.end as usize].to_owned();
    assert_eq!(
        table.row_lines.iter().map(line).collect::<Vec<_>>(),
        vec!["| a | b |", "| c | d |"]
    );
    assert_eq!(
        line(table.delimiter_line.as_ref().unwrap()),
        "| --- | --: |"
    );
    let a = &table.rows[0][0].content;
    let caret = EditorUtf16Range {
        start: a.end,
        end: a.end,
    };
    session
        .replace_utf16(0, caret, "x|y".encode_utf16().collect())
        .unwrap();
    let at = EditorByteRange { start: 2, end: 2 };
    let moved = session.table_key(1, EditorTableKey::Tab).unwrap().unwrap();
    assert_eq!(moved.selected.unwrap().revision, 1);
    assert!(moved.edited.is_none());
    session
        .table_command(1, at, EditorTableCommand::InsertColumnRight)
        .unwrap()
        .unwrap();
    session.checkpoint().unwrap();
    drop(session);
    drop(store);
    let store = NoteStore::new(path);
    let session = store.open_editor("grid".into()).unwrap();
    assert_eq!(
        session.source_text().unwrap(),
        "| ax\\|y |  | b |\r\n| --- | --- | --: |\r\n| c |  | d |\r\n"
    );
}

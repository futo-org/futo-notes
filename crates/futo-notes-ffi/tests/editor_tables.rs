mod support;
use futo_notes_ffi::{
    EditorByteRange, EditorStyleSpan, EditorTableCommand, EditorTableKey, EditorUtf16Range,
    NoteStore,
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
    // A typed pipe lands as typed: the body row gains a cell.
    let c = &table.rows[1][0].content;
    let caret = EditorUtf16Range {
        start: c.end,
        end: c.end,
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
        "| a |  | b |\r\n| --- | --- | --: |\r\n| cx|  |y | d |\r\n"
    );
}

/// The host restyles the window an edit reparsed: one keystroke in the middle of a big table
/// plans the rows near it, not every row of the table.
#[test]
fn a_keystroke_in_a_big_table_restyles_only_the_rows_near_it() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    let mut source = String::from("| a | b |\n|:-|-:|\n");
    for i in 0..2_000 {
        source.push_str(&format!("| row {i} | b{i} |\n"));
    }
    store.create_note("big".into(), "".into(), source).unwrap();
    let session = store.open_editor("big".into()).unwrap();
    let display = session.display_text().unwrap();
    let at = display.find("| row 1000 |").unwrap() + 3;
    let caret = display[..at].encode_utf16().count() as u64;
    let change = session
        .replace_utf16(
            0,
            EditorUtf16Range {
                start: caret,
                end: caret,
            },
            "z".encode_utf16().collect(),
        )
        .unwrap();
    let spans = session
        .style_plan(change.revision, change.projection.range.clone())
        .unwrap();
    let rows = spans
        .iter()
        .filter(|span| matches!(span, EditorStyleSpan::TableRow { .. }))
        .count();
    assert!(
        (1..=200).contains(&rows),
        "{rows} rows planned for one keystroke"
    );
    assert!(!spans
        .iter()
        .any(|span| matches!(span, EditorStyleSpan::TableDelimiter { .. })));
}

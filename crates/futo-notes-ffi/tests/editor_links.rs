mod support;
use futo_notes_ffi::{EditorByteRange, EditorUtf16Range, NoteStore};
use support::{path_string, TempTree};

#[test]
fn native_link_commands_and_corrections_recover_exact_source_and_destinations() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let path = path_string(&tree.path("vault"));
    let store = NoteStore::new(path.clone());
    let original = "see [teh __docs__](https://old.test 'Title')\r\n";
    store
        .create_note("links".into(), "".into(), original.into())
        .unwrap();
    let session = store.open_editor("links".into()).unwrap();
    let mut display = "see teh docs\r\n".to_owned();
    let change = session
        .replace_utf16(
            0,
            EditorUtf16Range { start: 4, end: 7 },
            "the".encode_utf16().collect(),
        )
        .unwrap();
    display.replace_range(
        change.range.start as usize..change.range.end as usize,
        &change.inserted,
    );
    assert_eq!(display, "see the docs\r\n");
    let link = session
        .inspect_link(1, EditorByteRange { start: 5, end: 6 })
        .unwrap()
        .unwrap();
    assert_eq!(link.range, EditorByteRange { start: 4, end: 12 });
    assert_eq!(link.destination, "https://old.test");
    let change = session
        .set_link(
            1,
            EditorByteRange { start: 5, end: 6 },
            "https://x.test".into(),
        )
        .unwrap()
        .unwrap();
    display.replace_range(
        change.range.start as usize..change.range.end as usize,
        &change.inserted,
    );
    let updated = "see [the __docs__](https://x.test 'Title')\r\n";
    assert_eq!(session.source_text().unwrap(), updated);
    assert_eq!(display, "see the docs\r\n");
    session.undo(2).unwrap().unwrap();
    assert_eq!(
        session.source_text().unwrap(),
        "see [the __docs__](https://old.test 'Title')\r\n"
    );
    session.redo(3).unwrap().unwrap();
    session.flush_recovery().unwrap();
    drop(session);
    drop(store);
    let store = NoteStore::new(path);
    let session = store.open_editor("links".into()).unwrap();
    assert_eq!(session.source_text().unwrap(), updated);
    let projection = session
        .project(4, EditorByteRange { start: 0, end: 14 })
        .unwrap();
    assert_eq!(projection.text, "see the docs\r\n");
    assert_eq!(projection.links[0].destination, "https://x.test");
    session.checkpoint().unwrap();
    assert_eq!(store.read("links".into()).unwrap(), updated);
}

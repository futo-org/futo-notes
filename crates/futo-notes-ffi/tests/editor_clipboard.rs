mod support;
use futo_notes_ffi::{EditorByteRange, NoteStore};
use support::{path_string, TempTree};

#[test]
fn native_clipboard_copies_cuts_and_pastes_exact_markdown() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("clip".into(), "".into(), "- ab **cd**\n".into())
        .unwrap();
    let session = store.open_editor("clip".into()).unwrap();
    let at = |start, end| EditorByteRange { start, end };
    assert_eq!(session.copy_markdown(0, at(4, 5)).unwrap(), "**d**");
    session
        .paste_markdown(0, at(3, 3), "- x\n- y\n".into())
        .unwrap()
        .unwrap();
    assert_eq!(
        session.source_text().unwrap(),
        "- ab \n- x\n- y\n- **cd**\n"
    );
    let cut = session.cut_markdown(1, at(8, 10)).unwrap();
    assert_eq!(cut.markdown, "- **cd**");
    assert!(cut.change.is_some());
    assert_eq!(session.source_text().unwrap(), "- ab \n- x\n- y\n- \n");
    session.undo(2).unwrap().unwrap();
    session.undo(3).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), "- ab **cd**\n");
}

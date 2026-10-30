mod support;
use futo_notes_ffi::{EditorByteRange, EditorParagraphKey, EditorUtf16Range, NoteStore};
use support::{path_string, TempTree};

#[test]
fn native_list_projection_and_enter_forward_exact_source_and_recovery() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    let opening = "5) [X] 🦊done\n1) tail\n\n+ keep";
    store
        .create_note("lists".into(), "".into(), opening.into())
        .unwrap();
    let session = store.open_editor("lists".into()).unwrap();
    let projection = session
        .project(0, EditorByteRange { start: 0, end: 19 })
        .unwrap();
    let list = projection.blocks[0].list.as_ref().unwrap();
    assert_eq!(list.number, Some(5));
    assert_eq!(list.checked, Some(true));
    assert_eq!(list.depth, 1);
    let change = session
        .paragraph_key_utf16(
            0,
            EditorUtf16Range { start: 4, end: 4 },
            EditorParagraphKey::Enter,
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        session.source_text().unwrap(),
        "5) [X] 🦊do\n6) [ ] ne\n7) tail\n\n+ keep"
    );
    assert_eq!(session.display_text().unwrap(), "🦊do\nne\ntail\n\nkeep");
    assert_eq!(change.selection.start, 7);
    session.undo(1).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), opening);
    session.redo(2).unwrap().unwrap();
    session.flush_recovery().unwrap();
    session.detach().unwrap();
    let recovered = store.open_editor("lists".into()).unwrap();
    assert_eq!(
        recovered.source_text().unwrap(),
        "5) [X] 🦊do\n6) [ ] ne\n7) tail\n\n+ keep"
    );
    recovered.checkpoint().unwrap();
    assert_eq!(
        store.read("lists".into()).unwrap(),
        "5) [X] 🦊do\n6) [ ] ne\n7) tail\n\n+ keep"
    );
}

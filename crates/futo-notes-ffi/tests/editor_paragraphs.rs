mod support;
use futo_notes_ffi::{EditorParagraphKey, EditorUtf16Range, NoteStore};
use support::{path_string, TempTree};

#[test]
fn native_paragraph_keys_preserve_exact_newlines_history_and_recovery() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("lines".into(), "".into(), "__a😀b__\r\ntail  \r\n".into())
        .unwrap();
    let session = store.open_editor("lines".into()).unwrap();
    session
        .select_utf16(0, EditorUtf16Range { start: 8, end: 8 })
        .unwrap();
    let enter = session
        .paragraph_key_utf16(
            0,
            EditorUtf16Range { start: 3, end: 3 },
            EditorParagraphKey::Enter,
        )
        .unwrap()
        .unwrap();
    assert_eq!(enter.selection.start, 6);
    assert_eq!(session.source_text().unwrap(), "__a😀\nb__\r\ntail  \r\n");
    session
        .paragraph_key_utf16(
            1,
            EditorUtf16Range { start: 4, end: 4 },
            EditorParagraphKey::Backspace,
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text().unwrap(), "__a😀b__\r\ntail  \r\n");
    session.undo(2).unwrap().unwrap();
    session.flush_recovery().unwrap();
    session.detach().unwrap();
    let recovered = store.open_editor("lines".into()).unwrap();
    assert_eq!(recovered.source_text().unwrap(), "__a😀\nb__\r\ntail  \r\n");
    recovered.checkpoint().unwrap();
    assert_eq!(
        store.read("lines".into()).unwrap(),
        "__a😀\nb__\r\ntail  \r\n"
    );
}

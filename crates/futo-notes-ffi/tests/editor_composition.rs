mod support;
use futo_notes_ffi::{EditorInputAction, EditorSessionError, EditorUtf16Range, NoteStore};
use support::{path_string, TempTree};

#[test]
fn native_composition_and_os_correction_forward_exact_source_and_errors() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("input".into(), "".into(), "__teh__ &amp; wrng\r\n".into())
        .unwrap();
    let session = store.open_editor("input".into()).unwrap();
    let marked = session
        .compose_utf16(
            0,
            EditorUtf16Range { start: 0, end: 3 },
            "て".encode_utf16().collect(),
        )
        .unwrap();
    assert_eq!(marked.text, "て");
    assert_eq!(session.source_text().unwrap(), "__teh__ &amp; wrng\r\n");
    assert!(matches!(
        session.compose_utf16(0, EditorUtf16Range { start: 0, end: 3 }, vec![0xd800]),
        Err(EditorSessionError::InvalidText)
    ));
    assert!(matches!(
        session.replace_utf16_action(
            0,
            EditorUtf16Range { start: 0, end: 1 },
            "the".encode_utf16().collect(),
            EditorInputAction::CompositionCommit
        ),
        Err(EditorSessionError::CompositionActive)
    ));
    session
        .commit_composition_utf16(0, Some("the".encode_utf16().collect()))
        .unwrap()
        .unwrap();
    session
        .replace_os_utf16(
            1,
            EditorUtf16Range { start: 0, end: 12 },
            "the & wrong\r\n".encode_utf16().collect(),
            vec![],
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text().unwrap(), "__the__ &amp; wrong\r\n");
    session.detach().unwrap();
    let recovered = store.open_editor("input".into()).unwrap();
    assert_eq!(recovered.source_text().unwrap(), "__the__ &amp; wrong\r\n");
    assert!(recovered.composition().unwrap().is_none());
}

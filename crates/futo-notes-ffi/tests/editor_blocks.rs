mod support;
use futo_notes_ffi::{EditorBlockCommand, EditorParagraphKey, EditorUtf16Range, NoteStore};
use support::{path_string, TempTree};
#[test]
fn native_block_commands_project_structure_and_recover_exact_source() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("blocks".into(), "".into(), "😀ab\r\ntail  \r\n".into())
        .unwrap();
    let session = store.open_editor("blocks".into()).unwrap();
    let heading = session
        .block_command_utf16(
            0,
            EditorUtf16Range { start: 2, end: 2 },
            EditorBlockCommand::Heading { level: 6 },
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text().unwrap(), "###### 😀ab\r\ntail  \r\n");
    assert_eq!(heading.projection.blocks[0].heading, 6);
    session
        .paragraph_key_utf16(
            1,
            EditorUtf16Range { start: 3, end: 3 },
            EditorParagraphKey::Enter,
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        session.source_text().unwrap(),
        "###### 😀a\nb\r\ntail  \r\n"
    );
    session.undo(2).unwrap().unwrap();
    session.redo(3).unwrap().unwrap();
    session.flush_recovery().unwrap();
    session.detach().unwrap();
    let recovered = store.open_editor("blocks".into()).unwrap();
    assert_eq!(
        recovered.source_text().unwrap(),
        "###### 😀a\nb\r\ntail  \r\n"
    );
    recovered.checkpoint().unwrap();
    assert_eq!(
        store.read("blocks".into()).unwrap(),
        "###### 😀a\nb\r\ntail  \r\n"
    );
}

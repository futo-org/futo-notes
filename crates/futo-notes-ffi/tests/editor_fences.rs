mod support;
use futo_notes_ffi::{EditorBlockCommand, EditorParagraphKey, EditorUtf16Range, NoteStore};
use support::{path_string, TempTree};

#[test]
fn native_fences_expose_language_and_recover_literal_unicode_code_input() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    let opening = "~~~~ c++ info\r\n猫🦊\r\n~~~~~  \r\n\n__tail__";
    let expected = "~~~~ c++ info\r\n猫\n🦊\r\n~~~~~  \r\n\n__tail__";
    store
        .create_note("code".into(), "".into(), opening.into())
        .unwrap();
    let session = store.open_editor("code".into()).unwrap();
    assert_eq!(session.display_text().unwrap(), "猫🦊\r\n\ntail");
    let change = session
        .paragraph_key_utf16(
            0,
            EditorUtf16Range { start: 1, end: 1 },
            EditorParagraphKey::Enter,
        )
        .unwrap()
        .unwrap();
    let code = change
        .projection
        .blocks
        .iter()
        .find(|block| block.code)
        .unwrap();
    assert_eq!(code.language.as_deref(), Some("c++"));
    let mut view = "猫🦊\r\n\ntail".to_owned();
    view.replace_range(
        change.range.start as usize..change.range.end as usize,
        &change.inserted,
    );
    assert_eq!(view, "猫\n🦊\r\n\ntail");
    assert_eq!(session.source_text().unwrap(), expected);
    session.undo(1).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), opening);
    session.redo(2).unwrap().unwrap();
    session.flush_recovery().unwrap();
    session.detach().unwrap();
    let recovered = store.open_editor("code".into()).unwrap();
    assert_eq!(recovered.source_text().unwrap(), expected);
    recovered.checkpoint().unwrap();
    assert_eq!(store.read("code".into()).unwrap(), expected);
}

#[test]
fn native_code_tab_and_shift_tab_forward_intent_without_markdown_policy() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("code".into(), "".into(), "~~~js\nab\n cd\n~~~".into())
        .unwrap();
    let session = store.open_editor("code".into()).unwrap();
    session
        .paragraph_key_utf16(
            0,
            EditorUtf16Range { start: 1, end: 1 },
            EditorParagraphKey::Tab,
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text().unwrap(), "~~~js\na  b\n cd\n~~~");
    session
        .paragraph_key_utf16(
            1,
            EditorUtf16Range { start: 6, end: 6 },
            EditorParagraphKey::ShiftTab,
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text().unwrap(), "~~~js\na  b\ncd\n~~~");
}

#[test]
fn native_code_block_command_remains_a_thin_engine_projection() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("code".into(), "".into(), "ab".into())
        .unwrap();
    let session = store.open_editor("code".into()).unwrap();
    session
        .block_command_utf16(
            0,
            EditorUtf16Range { start: 0, end: 0 },
            EditorBlockCommand::CodeBlock,
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text().unwrap(), "```\nab\n```");
    assert_eq!(session.display_text().unwrap(), "ab\n");
}

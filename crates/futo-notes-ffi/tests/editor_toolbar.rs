//! The toolbar's state and the block commands its buttons run.
mod support;
use futo_notes_ffi::{EditorUtf16Range, NoteStore};
use support::{path_string, TempTree};

#[test]
fn native_toolbar_state_projects_selection_coverage_and_history_in_one_query() {
    use futo_notes_ffi::EditorInlineFormat;
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("n".into(), "".into(), "**bold** plain".into())
        .unwrap();
    let session = store.open_editor("n".into()).unwrap();
    session
        .select_utf16(0, EditorUtf16Range { start: 0, end: 10 })
        .unwrap();
    let state = session.toolbar_state().unwrap();
    assert!(state.formats.is_empty());
    assert!(!state.can_undo);
    assert!(!state.can_indent);
    session
        .select_utf16(0, EditorUtf16Range { start: 0, end: 4 })
        .unwrap();
    assert_eq!(
        session.toolbar_state().unwrap().formats,
        vec![EditorInlineFormat::Bold]
    );
    assert_eq!(session.source_text().unwrap(), "**bold** plain");
    assert_eq!(session.revision().unwrap(), 0);
    // Saved EOF and a multiscalar native caret retain the same code owner.
    for (id, body, end) in [("ascii", "code", 4), ("emoji", "🧑‍💻", 5)] {
        let source = format!("```\n{body}\n```\n");
        store
            .create_note(id.into(), "".into(), source.clone())
            .unwrap();
        let code = store.open_editor(id.into()).unwrap();
        code.select_utf16(0, EditorUtf16Range { start: end, end })
            .unwrap();
        let state = code.toolbar_state().unwrap();
        assert!(state.code);
        assert!(!state.inline_allowed);
        assert!(!state.mixed);
        assert!(code
            .toggle_format(0, EditorInlineFormat::Bold)
            .unwrap()
            .is_none());
        assert!(code.toolbar_state().unwrap().formats.is_empty());
        assert_eq!(code.source_text().unwrap(), source);
        assert_eq!(code.revision().unwrap(), 0);
    }
}

#[test]
fn native_text_first_commands_preserve_explicit_portable_variants() {
    use futo_notes_ffi::{EditorBlockCommand, EditorParagraphKey};
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("n".into(), "".into(), "above\n# title".into())
        .unwrap();
    let session = store.open_editor("n".into()).unwrap();
    session
        .paragraph_key_utf16(
            0,
            EditorUtf16Range { start: 6, end: 6 },
            EditorParagraphKey::BackspaceJoiningHeading,
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text().unwrap(), "abovetitle");
    let rev = session.revision().unwrap();
    let range = EditorUtf16Range { start: 0, end: 0 };
    session
        .block_command_utf16(
            rev,
            range.clone(),
            EditorBlockCommand::ToggleHeading { level: 1 },
        )
        .unwrap()
        .unwrap();
    session
        .block_command_utf16(
            session.revision().unwrap(),
            range.clone(),
            EditorBlockCommand::ToggleHeading { level: 1 },
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text().unwrap(), "abovetitle");
    session
        .block_command_utf16(
            session.revision().unwrap(),
            range,
            EditorBlockCommand::WrapCodeBlock,
        )
        .unwrap()
        .unwrap();
    assert!(session
        .source_text()
        .unwrap()
        .starts_with("```\nabovetitle"));
}

#[test]
fn native_toolbar_allows_only_the_commands_that_would_act_and_a_menu_pick_is_one_undo_step() {
    use futo_notes_ffi::{EditorBlockCommand, EditorToolbarCommand};
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("n".into(), "".into(), "```\ncode\n```\n/ta".into())
        .unwrap();
    let session = store.open_editor("n".into()).unwrap();
    let in_code = EditorUtf16Range { start: 2, end: 2 };
    session.select_utf16(0, in_code).unwrap();
    let state = session.toolbar_state().unwrap();
    assert_eq!(state.allowed, vec![EditorToolbarCommand::CodeBlock]);

    // `/ta` typed after the code block, picked as a table from a menu.
    let typed = EditorUtf16Range { start: 5, end: 8 };
    session
        .select_utf16(0, EditorUtf16Range { start: 8, end: 8 })
        .unwrap();
    let table = EditorBlockCommand::Table {
        rows: 2,
        columns: 2,
    };
    session
        .block_command_removing_utf16(0, typed, table)
        .unwrap()
        .unwrap();
    let written = "```\ncode\n```\n|  |  |\n| --- | --- |\n|  |  |";
    assert_eq!(session.source_text().unwrap(), written);
    session.undo(session.revision().unwrap()).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), "```\ncode\n```\n/ta");
    assert!(!session.toolbar_state().unwrap().can_undo);
}

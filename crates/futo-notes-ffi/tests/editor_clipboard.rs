mod support;
use futo_notes_ffi::{EditorByteRange, NoteStore};
use support::{path_string, TempTree};

#[test]
fn native_clipboard_copies_cuts_and_pastes_exact_markdown() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("clip".into(), "".into(), "- ab **cd**".into())
        .unwrap();
    let session = store.open_editor("clip".into()).unwrap();
    let at = |start, end| EditorByteRange { start, end };
    assert_eq!(session.copy_markdown(0, at(4, 5)).unwrap(), "**d**");
    session
        .paste_markdown(0, at(3, 3), "- x\n- y\n".into())
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text().unwrap(), "- ab \n- x\n- y\n- **cd**");
    let cut = session.cut_markdown(1, at(8, 10)).unwrap();
    assert_eq!(cut.markdown, "- **cd**");
    assert!(cut.change.is_some());
    assert_eq!(session.source_text().unwrap(), "- ab \n- x\n- y\n- ");
    session.undo(2).unwrap().unwrap();
    session.undo(3).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), "- ab **cd**");
}

#[test]
fn native_block_paste_in_an_empty_fence_stays_literal() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    let original = "```\n\n```\n";
    store
        .create_note("empty-code".into(), "".into(), original.into())
        .unwrap();
    let session = store.open_editor("empty-code".into()).unwrap();
    let at = |start, end| EditorByteRange { start, end };
    let change = session
        .paste_markdown(0, at(0, 0), "# h".into())
        .unwrap()
        .unwrap();
    assert_eq!(change.selection, at(3, 3));
    let expected = "```\n# h\n```\n";
    assert_eq!(session.source_text().unwrap(), expected);
    assert_eq!(session.display_text().unwrap(), "# h\n");
    assert!(session.toolbar_state().unwrap().code);
    assert_eq!(session.undo(1).unwrap().unwrap().selection, at(0, 0));
    assert_eq!(session.source_text().unwrap(), original);
    assert_eq!(session.redo(2).unwrap().unwrap().selection, at(3, 3));
    session.checkpoint().unwrap();
    drop(session);
    let reopened = store.open_editor("empty-code".into()).unwrap();
    assert_eq!(reopened.source_text().unwrap(), expected);
    assert_eq!(reopened.display_text().unwrap(), "# h\n");
}

#[test]
fn native_named_link_paste_maps_visible_caret_and_survives_history_and_reopen() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("linkclip".into(), "".into(), "猫a tail\n".into())
        .unwrap();
    let session = store.open_editor("linkclip".into()).unwrap();
    let at = |start, end| EditorByteRange { start, end };
    session
        .select_with_affinity(0, at(4, 4), futo_notes_ffi::EditorAffinity::Forward)
        .unwrap();
    let change = session
        .paste_markdown(0, at(4, 4), "[λ](<https://x.test> 'T')".into())
        .unwrap()
        .unwrap();
    assert_eq!(change.selection, at(6, 6));
    let expected = "猫a[λ](<https://x.test> 'T') tail\n";
    assert_eq!(session.source_text().unwrap(), expected);
    assert_eq!(session.display_text().unwrap(), "猫aλ tail\n");
    let link = session.inspect_link(1, at(4, 6)).unwrap().unwrap();
    assert_eq!(link.destination, "https://x.test");
    assert_eq!(link.title.as_deref(), Some("T"));
    assert_eq!(session.undo(1).unwrap().unwrap().selection, at(4, 4));
    assert_eq!(session.source_text().unwrap(), "猫a tail\n");
    assert_eq!(session.redo(2).unwrap().unwrap().selection, at(6, 6));
    assert_eq!(session.source_text().unwrap(), expected);
    session.checkpoint().unwrap();
    drop(session);
    let reopened = store.open_editor("linkclip".into()).unwrap();
    assert_eq!(reopened.source_text().unwrap(), expected);
    assert_eq!(
        reopened
            .inspect_link(0, at(4, 6))
            .unwrap()
            .unwrap()
            .destination,
        "https://x.test"
    );
}

/// Pasting over a selection from a block's code past it writes what typing
/// writes: the frame stays and the pasted line is code (fenced-code.md).
#[test]
fn native_block_paste_from_code_over_prose_keeps_the_frame() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    let original = "```\n\n```\n\nplain\n";
    store
        .create_note("selected-code".into(), "".into(), original.into())
        .unwrap();
    let session = store.open_editor("selected-code".into()).unwrap();
    let at = |start, end| EditorByteRange { start, end };
    session
        .select_with_affinity(0, at(0, 8), futo_notes_ffi::EditorAffinity::Forward)
        .unwrap();
    let change = session
        .paste_markdown(0, at(0, 8), "# h".into())
        .unwrap()
        .unwrap();
    assert_eq!(change.selection, at(3, 3));
    assert_eq!(session.source_text().unwrap(), "```\n# h\n```");
    assert_eq!(session.display_text().unwrap(), "# h");
    let toolbar = session.toolbar_state().unwrap();
    assert!(toolbar.code);
    assert_eq!(toolbar.heading, None);
    assert_eq!(session.undo(1).unwrap().unwrap().selection, at(0, 8));
    assert_eq!(session.source_text().unwrap(), original);
    assert_eq!(session.redo(2).unwrap().unwrap().selection, at(3, 3));
    session.checkpoint().unwrap();
    drop(session);
    let reopened = store.open_editor("selected-code".into()).unwrap();
    assert_eq!(reopened.source_text().unwrap(), "```\n# h\n```");
    assert_eq!(reopened.display_text().unwrap(), "# h");
}

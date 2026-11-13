use super::*;

#[test]
fn paste_and_cut_survive_rejected_append_recovery_and_checkpoint() {
    let root = TestRoot::new();
    let store = store(&root);
    let original = "ab **cd**\r\nend\r\n";
    store.create("", "clip", original).unwrap();
    let mut session = store.open_editor("clip").unwrap();
    assert_eq!(session.source_text(), original);
    // A paused draft stays copyable.
    assert_eq!(
        session.copy_markdown(Revision(0), range(4, 5)).unwrap(),
        "**d**"
    );
    session
        .paste_markdown(Revision(0), range(1, 1), "x \t\n# T\ny")
        .unwrap()
        .unwrap();
    let pasted = "ax \t\r\n# T\r\nyb **cd**\r\nend\r\n";
    assert_eq!(session.source_text(), pasted);
    let (copied, _) = session.cut_markdown(Revision(1), range(12, 14)).unwrap();
    assert_eq!(copied, "**cd**");
    let cut = "ax \t\r\n# T\r\nyb \r\nend\r\n";
    assert_eq!(session.source_text(), cut);
    session.undo(Revision(2)).unwrap().unwrap();
    assert_eq!(session.source_text(), pasted);
    session.redo(Revision(3)).unwrap().unwrap();
    session.checkpoint().unwrap();
    drop(session);
    let mut recovered = store.open_editor("clip").unwrap();
    assert_eq!(recovered.source_text(), cut);
    recovered.checkpoint().unwrap();
    assert_eq!(store.read("clip").unwrap(), cut);
}

#[test]
fn block_paste_in_empty_code_is_literal_through_checkpoint() {
    let root = TestRoot::new();
    let store = store(&root);
    let original = "```\n\n```\n";
    store.create("", "empty-code", original).unwrap();
    let mut session = store.open_editor("empty-code").unwrap();
    let change = session
        .paste_markdown(Revision(0), range(0, 0), "# h")
        .unwrap()
        .unwrap();
    assert_eq!(change.selection, range(3, 3));
    let expected = "```\n# h\n```\n";
    assert_eq!(session.source_text(), expected);
    assert_eq!(session.display_text(), "# h\n");
    session.undo(Revision(1)).unwrap().unwrap();
    assert_eq!(session.source_text(), original);
    session.redo(Revision(2)).unwrap().unwrap();
    session.checkpoint().unwrap();
    drop(session);
    let reopened = store.open_editor("empty-code").unwrap();
    assert_eq!(reopened.source_text(), expected);
    assert_eq!(reopened.display_text(), "# h\n");
}

/// Pasting over a selection from a block's code past it writes what typing
/// writes: the frame stays and the pasted line is code (fenced-code.md).
#[test]
fn block_paste_from_code_over_prose_keeps_the_frame_as_one_saved_action() {
    let root = TestRoot::new();
    let store = store(&root);
    let original = "```\n\n```\n\nplain\n";
    store.create("", "selected-code", original).unwrap();
    let mut session = store.open_editor("selected-code").unwrap();
    session
        .select_with_affinity(
            Revision(0),
            range(0, 8),
            futo_notes_editor::Affinity::Forward,
        )
        .unwrap();
    let change = session
        .paste_markdown(Revision(0), range(0, 8), "# h")
        .unwrap()
        .unwrap();
    assert_eq!(change.selection, range(3, 3));
    assert_eq!(session.source_text(), "```\n# h\n```");
    assert_eq!(session.display_text(), "# h");
    assert_eq!(
        session.undo(Revision(1)).unwrap().unwrap().selection,
        range(0, 8)
    );
    assert_eq!(session.source_text(), original);
    assert_eq!(
        session.redo(Revision(2)).unwrap().unwrap().selection,
        range(3, 3)
    );
    session.checkpoint().unwrap();
    drop(session);
    let reopened = store.open_editor("selected-code").unwrap();
    assert_eq!(reopened.source_text(), "```\n# h\n```\n");
    assert_eq!(reopened.display_text(), "# h\n");
}

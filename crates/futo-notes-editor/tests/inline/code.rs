use super::{assert_fresh, range, EditorSession, ReferenceView, Revision};

#[test]
fn code_input_and_toggles_keep_marker_contents_isolated() {
    use futo_notes_editor::InlineFormat::Code;
    let original = "__left__ `a *b* [[x]] #tag` __right__";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("left a *b* [[x]] #tag right");
    session.select(Revision(0), range(6, 6)).unwrap();
    view.apply(
        session
            .replace(Revision(0), range(6, 6), "`", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(
        session.source_text(),
        "__left__ ``a` *b* [[x]] #tag`` __right__"
    );
    assert_eq!(view.text, "left a` *b* [[x]] #tag right");
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), original);
    session.select(Revision(2), range(0, 4)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(2), Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(
        session.source_text(),
        "__`left`__ `a *b* [[x]] #tag` __right__"
    );
    assert_eq!(view.text, "left a *b* [[x]] #tag right");
    session.select(Revision(3), range(5, 20)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(3), Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(view.text, "left a *b* [[x]] #tag right");
    assert_eq!(
        EditorSession::open(&session.source_text()).display_text(),
        view.text
    );
}

#[test]
fn editing_code_padding_keeps_exact_visible_spaces_and_delimiter_boundaries() {
    for (source, display, selected, inserted, expected_source, expected_display) in [
        ("` a b `", "a b", range(0, 1), "", "`  b `", " b"),
        ("`` a ` b ``", "a ` b", range(0, 5), " ", "`` ``", " "),
        ("`x`", "x", range(0, 0), "`", "`` `x ``", "`x"),
    ] {
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new(display);
        view.apply(
            session
                .replace(Revision(0), selected, inserted, &mut |_| Ok(()))
                .unwrap(),
        );
        assert_fresh(&session, &view);
        assert_eq!(view.text, expected_display);
        assert_eq!(session.source_text(), expected_source);
        view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
        assert_fresh(&session, &view);
        assert_eq!(session.source_text(), source);
    }
}

#[test]
fn code_commands_and_input_preserve_visible_line_breaks() {
    use futo_notes_editor::InlineFormat::Code;
    let mut session = EditorSession::open("a\r\nb");
    let mut view = ReferenceView::new("a\r\nb");
    session.select(Revision(0), range(0, 4)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(0), Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), "`a`\r\n`b`");
    assert_eq!(view.text, "a\r\nb");
    let mut session = EditorSession::open("`ab`");
    let mut view = ReferenceView::new("ab");
    view.apply(
        session
            .replace(Revision(0), range(1, 1), "\n", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_fresh(&session, &view);
    assert_eq!(session.source_text(), "`a`\n`b`");
    assert_eq!(view.text, "a\nb");
}

#[test]
fn nul_input_preserves_literal_source_display_selection_and_history() {
    for (source, expected_source) in [("__ab__", "__a\0b__"), ("`ab`", "`a\0b`")] {
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new("ab");
        view.apply(
            session
                .replace(Revision(0), range(1, 1), "\0", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected_source);
        assert_eq!(view.text, "a\0b");
        assert_eq!(session.selection(), range(2, 2));
        assert_fresh(&session, &view);
        view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), source);
        assert_fresh(&session, &view);
    }
}

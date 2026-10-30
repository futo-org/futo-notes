use super::*;

#[test]
fn formatting_commands_skip_code_while_formatting_selected_prose() {
    let mut session = EditorSession::open("left\n\n~~~x\nraw\n~~~\n\nright");
    let mut view = ReferenceView::new("left\n\nraw\n\nright");
    session
        .select(session.revision(), range(0, view.text.len()))
        .unwrap();
    view.apply(
        session
            .toggle_format(session.revision(), InlineFormat::Bold, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "**left**\n\n~~~x\nraw\n~~~\n\n**right**"
    );
    assert_eq!(view.text, "left\n\nraw\n\nright");
}

#[test]
fn typed_fence_trigger_closes_locally_and_undo_restores_literal_prefix() {
    let mut session = EditorSession::open("before\n\n\n\nafter\n\n~~~py\nold\n~~~");
    let mut view = ReferenceView::new("before\n\n\n\nafter\n\nold\n");
    session.select(session.revision(), range(8, 8)).unwrap();
    view.apply(
        session
            .replace(session.revision(), range(8, 8), "```c++", &mut |_| Ok(()))
            .unwrap(),
    );
    let before_trigger = session.source_text();
    assert_eq!(view.text, "before\n\n```c++\n\nafter\n\nold\n");
    view.apply(
        session
            .replace(
                session.revision(),
                session.selection(),
                " ",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "before\n\n```c++\n\n```\n\nafter\n\n~~~py\nold\n~~~"
    );
    assert_eq!(view.text, "before\n\n\n\nafter\n\nold\n");
    assert_eq!(session.selection(), range(8, 8));
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), before_trigger);
    assert_eq!(view.text, "before\n\n```c++\n\nafter\n\nold\n");
}

#[test]
fn code_block_command_wraps_only_its_selected_physical_lines() {
    let mut session = EditorSession::open("before\r\n\r\nab\r\n\r\nafter");
    let mut view = ReferenceView::new("before\r\n\r\nab\r\n\r\nafter");
    session.select(session.revision(), range(10, 12)).unwrap();
    view.apply(
        session
            .block_command(
                session.revision(),
                range(10, 12),
                BlockCommand::CodeBlock,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "before\r\n\r\n```\nab\n```\r\n\r\nafter"
    );
    assert_eq!(view.text, "before\r\n\r\nab\n\r\nafter");
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "before\r\n\r\nab\r\n\r\nafter");
}

#[test]
fn code_command_obeys_physical_line_heading_quote_list_and_existing_code_scope() {
    for (opening, shown, selected, expected, display) in [
        ("# __ab__ ##", "ab", range(0, 0), "```\nab\n```", "ab\n"),
        ("> one", "one", range(0, 0), "> ```\n> one\n> ```", "one\n"),
        (
            "one\ntwo",
            "one\ntwo",
            range(0, 7),
            "```\none\n```\n\n```\ntwo\n```",
            "one\n\ntwo\n",
        ),
        (
            "left\n\n~~~x\nraw\n~~~\n\nright",
            "left\n\nraw\n\nright",
            range(0, 16),
            "```\nleft\n```\n\n~~~x\nraw\n~~~\n\n```\nright\n```",
            "left\n\nraw\n\nright\n",
        ),
    ] {
        let mut session = EditorSession::open(opening);
        let mut view = ReferenceView::new(shown);
        session.select(session.revision(), selected).unwrap();
        view.apply(
            session
                .block_command(
                    session.revision(),
                    selected,
                    BlockCommand::CodeBlock,
                    &mut |_| Ok(()),
                )
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected, "{opening:?}");
        assert_eq!(view.text, display);
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), opening);
        assert_eq!(view.text, shown);
        assert_eq!(session.selection(), selected);
    }
    let mut session = EditorSession::open("- one");
    let mut calls = 0;
    assert!(session
        .block_command(
            session.revision(),
            range(0, 0),
            BlockCommand::CodeBlock,
            &mut |_| {
                calls += 1;
                Ok(())
            }
        )
        .unwrap()
        .is_none());
    assert_eq!(calls, 0);
    assert_eq!(session.source_text(), "- one");
}

#[test]
fn a_fence_like_prefix_inside_inline_code_does_not_trigger_block_conversion() {
    let mut session = EditorSession::open("`~~~js`");
    let mut view = ReferenceView::new("~~~js");
    session
        .select_with_affinity(session.revision(), range(5, 5), Affinity::Backward)
        .unwrap();
    view.apply(
        session
            .replace(session.revision(), range(5, 5), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), "`~~~js `");
    assert_eq!(view.text, "~~~js ");
}

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
    assert_eq!(view.text, "before\r\n\r\nab\r\n\r\nafter");
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
        ("# __ab__ ##", "ab", range(0, 0), "```\nab\n```", "ab"),
        ("> one", "one", range(0, 0), "> ```\n> one\n> ```", "one"),
        (
            "one\ntwo",
            "one\ntwo",
            range(0, 7),
            "```\none\n```\n\n```\ntwo\n```",
            "one\n\ntwo",
        ),
        (
            "left\n\n~~~x\nraw\n~~~\n\nright",
            "left\n\nraw\n\nright",
            range(0, 16),
            "```\nleft\n```\n\n~~~x\nraw\n~~~\n\n```\nright\n```",
            "left\n\nraw\n\nright",
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

#[test]
fn the_shipping_triple_backtick_shortcut_is_inert_inside_literal_inline_code() {
    let source = "```` ```js ````";
    let mut session = EditorSession::open(source);
    let mut view = ReferenceView::new("```js");
    assert_eq!(session.display_text(), view.text);
    session
        .select_with_affinity(session.revision(), range(5, 5), Affinity::Backward)
        .unwrap();
    view.apply(
        session
            .replace(session.revision(), range(5, 5), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "```js ");
    assert!(session.active_formats().contains(&InlineFormat::Code));
    assert!(!session
        .project(session.revision(), range(0, view.text.len()))
        .unwrap()
        .blocks
        .iter()
        .any(|b| b.code));
    assert_eq!(
        EditorSession::open(&session.source_text()).display_text(),
        view.text
    );
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), source);
    assert_eq!(view.text, "```js");
}

#[test]
fn code_command_on_a_code_line_takes_that_line_out_of_the_fence() {
    for (opening, shown, caret, expected) in [
        ("```\nx\n```", "x", range(0, 0), "x"),
        ("```\nx\ny\n```", "x\ny", range(2, 2), "```\nx\n```\ny"),
        ("```\nx\ny\n```", "x\ny", range(0, 0), "x\n```\ny\n```"),
        (
            "a\n\n```rust\nx\ny\nz\n```\n\nb",
            "a\n\nx\ny\nz\n\nb",
            range(5, 5),
            "a\n\n```rust\nx\n```\ny\n```rust\nz\n```\n\nb",
        ),
        ("```\nx\ny\n```", "x\ny", range(0, 3), "x\ny"),
        ("```\nx\ny", "x\ny", range(2, 2), "```\nx\n```\ny"),
        ("> ```\n> x\n> ```", "x", range(0, 0), "> x"),
    ] {
        let mut session = EditorSession::open(opening);
        let mut view = ReferenceView::new(shown);
        session.select(session.revision(), caret).unwrap();
        let change = session
            .block_command(
                session.revision(),
                caret,
                BlockCommand::CodeBlock,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap_or_else(|| panic!("{opening:?}: the command did nothing"));
        view.apply(change);
        assert_eq!(session.source_text(), expected, "{opening:?}");
        assert_eq!(view.text, shown, "the displayed text does not move");
        assert_eq!(session.selection(), caret);
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), opening);
    }
}

#[test]
fn code_command_on_an_empty_fence_removes_the_fence() {
    let mut session = EditorSession::open("a\n\n```\n```");
    session.select(session.revision(), range(3, 3)).unwrap();
    let change = session
        .block_command(
            session.revision(),
            range(3, 3),
            BlockCommand::CodeBlock,
            &mut |_| Ok(()),
        )
        .unwrap();
    assert!(change.is_some());
    assert!(
        !session.source_text().contains("```"),
        "{:?}",
        session.source_text()
    );
}

#[test]
fn code_command_takes_lines_out_as_plain_text_not_markdown_structure() {
    for (opening, shown, expected) in [
        ("```\n# x\n```", "# x", "\\# x"),
        ("```\n- a\n```", "- a", "\\- a"),
        ("```\n> q\n```", "> q", "\\> q"),
        ("```\n1. x\n```", "1. x", "1\\. x"),
        ("```\n---\n```", "---", "\\---"),
        ("```\n  x\n```", "  x", "&#32; x"),
        ("> ```\n> # x\n> ```", "# x", "> \\# x"),
        ("- a\n  ```\n  - b\n  ```", "a\n- b", "- a\n  \\- b"),
    ] {
        let mut session = EditorSession::open(opening);
        let mut view = ReferenceView::new(shown);
        let line = shown.rfind('\n').map_or(0, |at| at + 1);
        let caret = range(line, line);
        session.select(session.revision(), caret).unwrap();
        view.apply(
            session
                .block_command(
                    session.revision(),
                    caret,
                    BlockCommand::CodeBlock,
                    &mut |_| Ok(()),
                )
                .unwrap()
                .unwrap_or_else(|| panic!("{opening:?}: the command did nothing")),
        );
        assert_eq!(session.source_text(), expected, "{opening:?}");
        assert_eq!(
            view.text, shown,
            "{opening:?}: the displayed text does not move"
        );
        assert_eq!(
            session.display_text(),
            shown,
            "{opening:?}: plain text, not structure"
        );
    }
}

#[test]
fn android_code_command_wraps_selected_mixed_blocks_in_one_fence_and_one_undo() {
    let opening = "# **title**\n\n- one\n- two\n\n> quote\n\n~~~rs\ncode\n~~~\n\n| a | b |\n| - | - |\n| c | d |\n";
    let mut s = EditorSession::open(opening);
    let shown = s.display_text();
    let selected = range(0, shown.len());
    s.select(s.revision(), selected).unwrap();
    let mut accepted = 0;
    let change = s
        .block_command(
            s.revision(),
            selected,
            BlockCommand::WrapCodeBlock,
            &mut |_| {
                accepted += 1;
                Ok(())
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(
        s.source_text(),
        format!("```\n{}\n```\n", shown.trim_end_matches('\n'))
    );
    let mut view = ReferenceView::new(&shown);
    view.apply(change);
    assert_eq!(view.text, shown.trim_end_matches('\n'));
    assert_eq!(s.selection(), range(0, view.text.len()));
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), opening);
    assert_eq!(s.selection(), selected);
    assert!(s.undo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
}

#[test]
fn android_code_wrap_preserves_neighbors_and_uses_a_safe_fence() {
    for (opening, selected, expected) in [
        (
            "before\n\n# **one**\n\n*two*\n\nafter",
            range(8, 16),
            "before\n\n```\none\n\ntwo\n```\n\nafter",
        ),
        ("> one\n> two", range(0, 7), "> ```\n> one\n> two\n> ```"),
        ("- one\n- two", range(0, 7), "```\none\ntwo\n```"),
        (
            "````\n```\n````\n\ntext",
            range(0, 9),
            "````\n```\n\ntext\n````",
        ),
    ] {
        let mut s = EditorSession::open(opening);
        let shown = s.display_text();
        s.select(s.revision(), selected).unwrap();
        s.block_command(
            s.revision(),
            selected,
            BlockCommand::WrapCodeBlock,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(s.source_text(), expected, "{opening:?}: {shown:?}");
        assert!(s.selection().end.0 <= s.display_text().len());
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), opening);
    }
}

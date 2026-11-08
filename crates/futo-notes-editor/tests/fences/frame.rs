use super::*;

#[test]
fn fence_frame_line_ending_is_hidden_but_authored_blank_lines_remain_editable() {
    // The pinned shipping code schema displays mdast code.value: one terminal
    // ending belongs to the fence frame, additional endings belong to its text.
    for (source, shown) in [
        ("```\na\n```", "a"),
        ("```\na\n\n```", "a\n"),
        ("```\na\r\n```", "a"),
        ("> ```\n> a\n> ```", "a"),
        ("> > ~~~\n> > a\n> > \n> > ~~~~~  ", "a\n"),
        ("```\na\n", "a"),
        ("```\na", "a"),
        ("> ```\n> ```", ""),
        ("> ```\n> \n> ```", ""),
        ("> ```\n> \n> \n> ```", "\n"),
    ] {
        let session = EditorSession::open(source);
        assert_eq!(session.source_text(), source);
        assert_eq!(session.display_text(), shown, "{source:?}");
        assert_eq!(
            session
                .project(session.revision(), range(0, shown.len()))
                .unwrap()
                .text,
            shown
        );
    }
}

#[test]
fn empty_quoted_fence_input_and_enter_retain_exact_container_spelling() {
    for (source, inserted, expected, shown) in [
        ("> ```\n> ```", "x", "> ```\n> x\n> ```", "x"),
        ("> ~~~\n> ~~~", "x", "> ~~~\n> x\n> ~~~", "x"),
        ("> ```\n> ```", "\n", "> ```\n> \n> \n> ```", "\n"),
        (
            "> > ~~~~Rust\r\n> > ~~~~~  ",
            "x",
            "> > ~~~~Rust\r\n> > x\n> > ~~~~~  ",
            "x",
        ),
        (">\t```\n>\t```", "x", ">\t```\n>\tx\n>\t```", "x"),
    ] {
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new("");
        view.apply(
            session
                .replace_action(
                    session.revision(),
                    range(0, 0),
                    inserted,
                    InputAction::Isolated,
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected);
        assert_eq!(view.text, shown);
        assert_eq!(EditorSession::open(expected).display_text(), shown);
        assert!(session
            .project(session.revision(), range(0, shown.len()))
            .unwrap()
            .blocks
            .iter()
            .all(|b| b.code && b.quote_depth > 0));
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), source);
        assert_eq!(view.text, "");
    }
}

#[test]
fn deleting_authored_terminal_break_or_whole_body_never_selects_closing_frame() {
    for (source, shown, selected, expected, display) in [
        ("```\na\n\n```", "a\n", range(1, 2), "```\na\n```", "a"),
        (
            "~~~\na\r\n\r\n~~~~  ",
            "a\r\n",
            range(1, 3),
            "~~~\na\r\n~~~~  ",
            "a",
        ),
        (
            "> ```\n> a\n> ```",
            "a",
            range(0, 1),
            "> ```\n> \n> ```",
            "",
        ),
        (
            "> > ~~~\n> > a\n> > \n> > ~~~~~  ",
            "a\n",
            range(0, 2),
            "> > ~~~\n> > \n> > ~~~~~  ",
            "",
        ),
    ] {
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new(shown);
        view.apply(
            session
                .replace_action(
                    session.revision(),
                    selected,
                    "",
                    InputAction::Isolated,
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected);
        assert_eq!(view.text, display);
        assert_eq!(EditorSession::open(expected).display_text(), display);
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), source);
        assert_eq!(view.text, shown);
    }
}

#[test]
fn typed_shortcut_retains_shipping_exact_triple_backtick_grammar() {
    for prefix in ["~~~js", "~~~~", "````js", "`````", "~~~", "````"] {
        let mut session = EditorSession::open("");
        let mut view = ReferenceView::new("");
        view.apply(
            session
                .replace(session.revision(), range(0, 0), prefix, &mut |_| Ok(()))
                .unwrap(),
        );
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
        assert_eq!(view.text, format!("{prefix} "));
        assert_eq!(
            EditorSession::open(&session.source_text()).display_text(),
            view.text
        );
        assert!(!session
            .project(session.revision(), range(0, view.text.len()))
            .unwrap()
            .blocks
            .iter()
            .any(|b| b.code));
    }
}

#[test]
fn open_fence_enter_creates_one_editable_break_and_preserves_its_original_bytes() {
    for (source, shown, at, expected, display) in [
        ("```\na", "a", 1, "```\na\n\n", "a\n"),
        ("```\na\r\n", "a", 1, "```\na\r\n\r\n", "a\r\n"),
        ("> ~~~\n> a", "a", 1, "> ~~~\n> a\n> \n", "a\n"),
        ("> ~~~", "", 0, "> ~~~\n> \n> \n", "\n"),
    ] {
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new(shown);
        assert_eq!(session.display_text(), shown);
        view.apply(
            session
                .paragraph_key(
                    session.revision(),
                    range(at, at),
                    ParagraphKey::Enter,
                    &mut |_| Ok(()),
                )
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected);
        assert_eq!(view.text, display);
        let caret = at + display.len() - shown.len();
        assert_eq!(session.selection(), range(caret, caret));
        assert_eq!(EditorSession::open(expected).display_text(), display);
    }
}

#[test]
fn wider_fence_and_tilde_shortcuts_remain_literal_on_enter_too() {
    for prefix in ["~~~js", "````js"] {
        let mut session = EditorSession::open("");
        let mut view = ReferenceView::new("");
        view.apply(
            session
                .replace(session.revision(), range(0, 0), prefix, &mut |_| Ok(()))
                .unwrap(),
        );
        view.apply(
            session
                .paragraph_key(
                    session.revision(),
                    session.selection(),
                    ParagraphKey::Enter,
                    &mut |_| Ok(()),
                )
                .unwrap()
                .unwrap(),
        );
        assert_eq!(view.text, format!("{prefix}\n"));
        assert_eq!(
            EditorSession::open(&session.source_text()).display_text(),
            view.text
        );
    }
}

#[test]
fn end_enter_continues_the_body_prefix_rather_than_the_different_opener_prefix() {
    let mut session = EditorSession::open(">\t```\n> a\n> ```");
    let mut view = ReferenceView::new("a");
    view.apply(
        session
            .paragraph_key(
                session.revision(),
                range(1, 1),
                ParagraphKey::Enter,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), ">\t```\n> a\n> \n> ```");
    assert_eq!(view.text, "a\n");
}

#[test]
fn a_visible_separator_outside_the_code_body_is_not_silently_clamped_into_it() {
    let source = "```\na\n```\nafter";
    let mut session = EditorSession::open(source);
    let mut view = ReferenceView::new("a\nafter");
    let mut accepts = 0;
    let result = session.paragraph_key(
        session.revision(),
        range(1, 1),
        ParagraphKey::Delete,
        &mut |_| {
            accepts += 1;
            Ok(())
        },
    );
    match result {
        Ok(Some(change)) => {
            view.apply(change);
            assert_eq!(view.text, "aafter");
        }
        Err(EditorError::UnrepresentableFormat) => {
            assert_eq!(accepts, 0);
            assert_eq!(session.source_text(), source);
            assert_eq!(session.revision(), Revision(0));
        }
        other => panic!("foreign-body deletion must edit or reject explicitly: {other:?}"),
    }
}

#[test]
fn commonmark_body_events_keep_literal_fence_like_final_lines_inside_code() {
    for (source, shown) in [
        ("```\na\n```\u{a0}", "a\n```\u{a0}"),
        ("```\na\n```\u{b}", "a\n```\u{b}"),
        ("```\na\n    ```", "a\n    ```"),
        ("```\na\n> ```", "a\n> ```"),
    ] {
        let session = EditorSession::open(source);
        assert_eq!(session.source_text(), source);
        assert_eq!(session.display_text(), shown);
    }
}

#[test]
fn literal_nonclosers_do_not_respell_untouched_delimiters() {
    for trailing in ["\u{a0}", "\u{b}"] {
        let source = "```\na\n```";
        let inserted = format!("```{trailing}\n");
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new("a");
        view.apply(
            session
                .replace_action(
                    session.revision(),
                    range(0, 0),
                    &inserted,
                    InputAction::Isolated,
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        assert_eq!(session.source_text(), format!("```\n{inserted}a\n```"));
        assert_eq!(view.text, format!("{inserted}a"));
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), source);
        assert_eq!(view.text, "a");
    }
}

#[test]
fn list_container_termination_closes_code_and_keeps_a_visible_block_boundary() {
    // Synthetic structural reductions of recorded census6084 (F19), whose
    // original note and corpus identity remain in the local replay receipt.
    for (source, shown, sibling, expected, expected_display) in [
        (
            "* parent\n  ```\n  literal\n* sibling\n\n**outside**",
            "parent\nliteral\nsibling\n\noutside",
            16,
            "* parent\n  ```\n  literal\n* s!ibling\n\n**outside**",
            "parent\nliteral\ns!ibling\n\noutside",
        ),
        (
            "* parent\n  ```\n* sibling\n\n**outside**",
            "parent\nsibling\n\noutside",
            8,
            "* parent\n  ```\n* s!ibling\n\n**outside**",
            "parent\ns!ibling\n\noutside",
        ),
        (
            "> ```\n> literal\noutside",
            "literal\noutside",
            9,
            "> ```\n> literal\no!utside",
            "literal\no!utside",
        ),
    ] {
        let mut s = EditorSession::open(source);
        let mut view = ReferenceView::new(shown);
        assert_eq!(s.display_text(), shown, "{source:?}");
        assert_eq!(s.source_text(), source);
        assert!(s
            .project(s.revision(), range(sibling, sibling + 1))
            .unwrap()
            .blocks
            .iter()
            .filter(|block| block.range.start != block.range.end)
            .all(|block| !block.code));
        s.select(s.revision(), range(sibling, sibling)).unwrap();
        view.apply(
            s.replace_action(
                s.revision(),
                range(sibling, sibling),
                "!",
                InputAction::Isolated,
                &mut |_| Ok(()),
            )
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, expected_display);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), source);
        assert_eq!(view.text, shown);
    }
}

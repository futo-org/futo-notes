use super::*;

#[test]
fn enter_on_a_typed_language_opener_closes_only_that_line() {
    let mut session = EditorSession::open("\\`\\`\\`rust\n\ntail");
    let mut view = ReferenceView::new("```rust\n\ntail");
    session.select(session.revision(), range(7, 7)).unwrap();
    view.apply(
        session
            .paragraph_key(
                session.revision(),
                range(7, 7),
                ParagraphKey::Enter,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "```rust\n\n```\n\ntail");
    assert_eq!(view.text, "\n\ntail");
    assert_eq!(session.selection(), range(0, 0));
}

#[test]
fn code_commands_and_failed_input_preserve_state_until_one_acceptance() {
    let original = "```rust\n猫🦊\r\n```\n\nend";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("猫🦊\r\n\nend");
    session.select(session.revision(), range(0, 0)).unwrap();
    let mut accepted = 0;
    assert!(session
        .toggle_format(session.revision(), InlineFormat::Bold, &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .is_none());
    assert_eq!(accepted, 0);
    let failed = session.replace(session.revision(), range(3, 3), "!", &mut |_| {
        Err("append".into())
    });
    assert!(matches!(failed, Err(EditorError::Persistence(_))));
    assert_eq!(session.source_text(), original);
    assert_eq!(session.selection(), range(0, 0));
    assert_eq!(session.revision(), Revision(0));
    view.apply(
        session
            .paragraph_key(
                session.revision(),
                range(3, 3),
                ParagraphKey::Delete,
                &mut |_| {
                    accepted += 1;
                    Ok(())
                },
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "```rust\n猫\r\n```\n\nend");
    assert_eq!(view.text, "猫\r\n\nend");
    assert_eq!(accepted, 1);
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), original);
}

#[test]
fn code_tab_and_shift_tab_share_exact_history_and_supplied_selection() {
    for (selected, key, expected, display, caret) in [
        (
            range(1, 1),
            ParagraphKey::Tab,
            "~~~x\na  b\n cd\n~~~",
            "a  b\n cd",
            range(3, 3),
        ),
        (
            range(1, 5),
            ParagraphKey::Tab,
            "~~~x\n  ab\n   cd\n~~~",
            "  ab\n   cd",
            range(3, 9),
        ),
        (
            range(4, 4),
            ParagraphKey::ShiftTab,
            "~~~x\nab\ncd\n~~~",
            "ab\ncd",
            range(3, 3),
        ),
    ] {
        let opening = "~~~x\nab\n cd\n~~~";
        let mut session = EditorSession::open(opening);
        let mut view = ReferenceView::new("ab\n cd");
        assert_eq!(session.display_text(), view.text);
        session.select(session.revision(), selected).unwrap();
        view.apply(
            session
                .paragraph_key(session.revision(), selected, key, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected);
        assert_eq!(view.text, display);
        assert_eq!(session.selection(), caret);
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), opening);
        assert_eq!(session.selection(), selected);
    }
}

#[test]
fn empty_code_enter_returns_a_caret_that_types_in_its_new_body_line() {
    for (opening, shown, expected, display) in [
        ("```js\n```", "", "```js\n\nx\n```", "\nx"),
        (
            "```js\n```\nafter",
            "\nafter",
            "```js\n\nx\n```\nafter",
            "\nx\nafter",
        ),
    ] {
        let mut session = EditorSession::open(opening);
        let mut view = ReferenceView::new(shown);
        view.apply(
            session
                .paragraph_key(
                    session.revision(),
                    range(0, 0),
                    ParagraphKey::Enter,
                    &mut |_| Ok(()),
                )
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.selection(), range(1, 1));
        view.apply(
            session
                .replace(
                    session.revision(),
                    session.selection(),
                    "x",
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected);
        assert_eq!(view.text, display);
    }
}

#[test]
fn enter_on_the_empty_last_code_line_of_a_note_leaves_the_fence() {
    let mut session = EditorSession::open("```\ncode\n```");
    let mut view = ReferenceView::new("code");
    let press = |session: &mut EditorSession, view: &mut ReferenceView, at: usize| {
        let caret = range(at, at);
        session.select(session.revision(), caret).unwrap();
        view.apply(
            session
                .paragraph_key(session.revision(), caret, ParagraphKey::Enter, &mut |_| {
                    Ok(())
                })
                .unwrap()
                .unwrap(),
        );
    };
    // The first Enter is a newline inside the code, as ever.
    press(&mut session, &mut view, 4);
    assert_eq!(session.source_text(), "```\ncode\n\n```");
    assert_eq!(view.text, "code\n");
    // The second, on the now-empty last code line, leaves the fence.
    press(&mut session, &mut view, 5);
    assert_eq!(session.source_text(), "```\ncode\n```\n\n");
    assert_eq!(view.text, session.display_text());
    assert_eq!(session.selection(), range(6, 6));
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "```\ncode\n\n```");
}

#[test]
fn enter_on_an_empty_code_line_keeps_the_fence_when_text_follows() {
    let mut session = EditorSession::open("```\ncode\n\n```\n\nafter");
    let caret = range(5, 5);
    session.select(session.revision(), caret).unwrap();
    session
        .paragraph_key(session.revision(), caret, ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), "```\ncode\n\n\n```\n\nafter");
}

#[test]
fn enter_on_the_empty_last_line_of_a_nested_code_block_exits_at_its_container_level() {
    for (opening, caret, expected) in [
        ("> ```\n> code\n> \n> ```", 5, "> ```\n> code\n> ```\n> "),
        ("- ```\n  code\n  \n  ```", 5, "- ```\n  code\n  ```\n  "),
        (
            "- a\n  ```\n  code\n  \n  ```",
            7,
            "- a\n  ```\n  code\n  ```\n  ",
        ),
    ] {
        let mut session = EditorSession::open(opening);
        let caret = range(caret, caret);
        session.select(session.revision(), caret).unwrap();
        let mut view = ReferenceView::new(&session.display_text());
        view.apply(
            session
                .paragraph_key(session.revision(), caret, ParagraphKey::Enter, &mut |_| {
                    Ok(())
                })
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected, "{opening:?}");
        assert_eq!(view.text, session.display_text());
        let end = session.display_text().len();
        assert_eq!(session.selection(), range(end, end), "{opening:?}");
    }
}

#[test]
fn enter_on_a_code_block_selected_as_one_object_adds_a_line_after_it() {
    for (opening, select, expected, caret) in [
        // The last block of the note, with and without a final newline.
        ("```\ncode\n```", (0, 4), "```\ncode\n```\n\n", 6),
        ("```\ncode\n```\n", (0, 4), "```\ncode\n```\n\n", 6),
        ("```\na\nb\n```", (0, 3), "```\na\nb\n```\n\n", 5),
        // With text after, the new line sits between.
        (
            "```\ncode\n```\nafter",
            (0, 4),
            "```\ncode\n```\n\nafter",
            5,
        ),
        (
            "intro\n\n```\na\n```\n\nafter",
            (7, 8),
            "intro\n\n```\na\n```\n\n\nafter",
            9,
        ),
        // At its container's level.
        (
            "> ```\n> code\n> ```",
            (0, 4),
            "> ```\n> code\n> ```\n> ",
            5,
        ),
        (
            "- ```\n  code\n  ```",
            (0, 4),
            "- ```\n  code\n  ```\n  ",
            5,
        ),
        (
            "> ```\n> code\n> ```\n> after",
            (0, 4),
            "> ```\n> code\n> ```\n> \n> after",
            5,
        ),
        // CRLF keeps its ending.
        (
            "```\r\ncode\r\n```",
            (0, 4),
            "```\r\ncode\r\n```\r\n\r\n",
            8,
        ),
    ] {
        let mut session = EditorSession::open(opening);
        let selected = range(select.0, select.1);
        session.select(session.revision(), selected).unwrap();
        let mut view = ReferenceView::new(&session.display_text());
        view.apply(
            session
                .paragraph_key(
                    session.revision(),
                    selected,
                    ParagraphKey::Enter,
                    &mut |_| Ok(()),
                )
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected, "{opening:?}");
        assert_eq!(view.text, session.display_text());
        assert_eq!(session.selection(), range(caret, caret), "{opening:?}");
    }
}

#[test]
fn enter_on_a_selected_unclosed_code_block_keeps_the_code() {
    let mut session = EditorSession::open("```\ncode");
    let selected = range(0, 4);
    session.select(session.revision(), selected).unwrap();
    session
        .paragraph_key(
            session.revision(),
            selected,
            ParagraphKey::Enter,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), "```\ncode\n\n");
}

/// A fence opener typed in a list item opens its code block inside that item: the body and
/// closing rows sit at the item's content column, so the item, and the list, go on around it.
#[test]
fn enter_on_an_opener_typed_in_a_list_item_keeps_the_block_in_the_item() {
    // (note, its display, where the backticks are typed, the note after Enter)
    for (raw, shown, at, expected) in [
        ("- a\n- ", "a\n", 2, "- a\n- ```\n  \n  ```"),
        ("- a\n  - x", "a\nx", 2, "- a\n  - ```\n    x\n    ```"),
        (
            "> 1. a\n> 2. ",
            "a\n",
            2,
            "> 1. a\n> 2. ```\n>    \n>    ```",
        ),
    ] {
        let mut session = EditorSession::open(raw);
        assert_eq!(session.display_text(), shown, "{raw:?}");
        let end = at;
        let mut view = ReferenceView::new(shown);
        view.apply(
            session
                .replace(session.revision(), range(end, end), "```", &mut |_| Ok(()))
                .unwrap(),
        );
        let typed = session.source_text();
        let caret = session.selection();
        view.apply(
            session
                .paragraph_key(session.revision(), caret, ParagraphKey::Enter, &mut |_| {
                    Ok(())
                })
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected, "{raw:?}");
        let body = session.selection();
        let projected = session.project(session.revision(), body).unwrap();
        assert!(
            projected.blocks.iter().all(|b| b.code && b.list.is_some()),
            "the code row is in the list item: {raw:?} {:?}",
            projected.blocks
        );
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), typed, "{raw:?}");
    }
}

/// A task's text starts after its checkbox, where no fence can open: Enter after typed
/// backticks in a task is the task's own Enter, and the backticks stay its text, rather
/// than a closing fence written below the list that turns the rest of the note into code.
#[test]
fn enter_on_backticks_typed_in_a_task_continues_the_task_list() {
    let raw = "- [ ] a\n- [ ] \n\ntail\n";
    let mut session = EditorSession::open(raw);
    let mut view = ReferenceView::new("a\n\n\ntail\n");
    view.apply(
        session
            .replace(session.revision(), range(2, 2), "```", &mut |_| Ok(()))
            .unwrap(),
    );
    let caret = session.selection();
    view.apply(
        session
            .paragraph_key(session.revision(), caret, ParagraphKey::Enter, &mut |_| {
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "- [ ] a\n- [ ] \\```\n- [ ] \n\ntail\n"
    );
    assert_eq!(view.text, "a\n```\n\n\ntail\n");
    let tail = session.display_text().find("tail").unwrap();
    let projected = session
        .project(session.revision(), range(tail, tail + 4))
        .unwrap();
    assert!(projected.blocks.iter().all(|b| !b.code && b.list.is_none()));
}

#[test]
fn a_code_block_ending_a_saved_note_takes_enter_and_typing_at_its_last_line() {
    // Saving gives the note a final line ending, so the empty line after the
    // closing fence shares the display end with the code's last line.
    for opening in [
        "```\ncode\n```\n",
        "~~~\ncode\n~~~\n",
        "```rust\r\ncode\r\n```\r\n",
    ] {
        let fence = &opening[..opening.find('\n').unwrap() + 1];
        let closer = &opening[opening.find("code").unwrap() + 4..];
        let mut session = EditorSession::open(opening);
        let mut view = ReferenceView::new("code");
        let caret = range(4, 4);
        session.select(session.revision(), caret).unwrap();
        view.apply(
            session
                .replace(session.revision(), caret, "x", &mut |_| Ok(()))
                .unwrap_or_else(|e| panic!("{opening:?} typing: {e:?}")),
        );
        assert_eq!(session.source_text(), format!("{fence}codex{closer}"));
        assert_eq!(view.text, "codex");
        let caret = range(5, 5);
        view.apply(
            session
                .paragraph_key(session.revision(), caret, ParagraphKey::Enter, &mut |_| {
                    Ok(())
                })
                .unwrap_or_else(|e| panic!("{opening:?} Enter: {e:?}"))
                .unwrap(),
        );
        let ending = if fence.ends_with("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        assert_eq!(
            session.source_text(),
            format!("{fence}codex{ending}{closer}")
        );
        assert_eq!(view.text, format!("codex{ending}"));
        assert_eq!(view.text, session.display_text());
    }
}

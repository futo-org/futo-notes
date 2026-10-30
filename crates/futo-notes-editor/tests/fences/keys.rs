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
            "a  b\n cd\n",
            range(3, 3),
        ),
        (
            range(1, 5),
            ParagraphKey::Tab,
            "~~~x\n  ab\n   cd\n~~~",
            "  ab\n   cd\n",
            range(3, 9),
        ),
        (
            range(4, 4),
            ParagraphKey::ShiftTab,
            "~~~x\nab\ncd\n~~~",
            "ab\ncd\n",
            range(3, 3),
        ),
    ] {
        let opening = "~~~x\nab\n cd\n~~~";
        let mut session = EditorSession::open(opening);
        let mut view = ReferenceView::new("ab\n cd\n");
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
        ("```js\n```", "", "```js\n\nx\n```", "\nx\n"),
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

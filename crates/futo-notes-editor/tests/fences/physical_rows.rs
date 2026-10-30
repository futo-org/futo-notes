use super::*;

#[test]
fn authored_blank_crlf_is_opaque_body_text_not_hidden_container_syntax() {
    for (source, shown) in [
        ("```Rust\r\na\r\n\r\nb\r\n```", "a\r\n\r\nb"),
        ("  ```Rust\r\n  a\r\n  \r\n  b\r\n  ```", "a\r\n\r\nb"),
        (
            ">   ```Rust\r\n>   a\r\n>   \r\n>   b\r\n>   ```",
            "a\r\n\r\nb",
        ),
        ("  ```Rust\r\n  a\r\n   \r\n  b\r\n  ```", "a\r\n \r\nb"),
        ("> ```Rust\r\n> a\r\n> \r\n> b\r\n> ```", "a\r\n\r\nb"),
        ("```Rust\r\na\r\n\r\n", "a\r\n"),
        ("  ```Rust\r\n  a\r\n\r\n  b\r\n  ```", "a\r\n\r\nb"),
    ] {
        let session = EditorSession::open(source);
        assert_eq!(session.source_text(), source);
        assert_eq!(session.display_text(), shown, "{source:?}");
        let projection = session
            .project(session.revision(), range(0, shown.len()))
            .unwrap();
        assert_eq!(projection.text, shown);
        assert!(projection.blocks.iter().all(|block| block.code));
    }
}

#[test]
fn open_crlf_blank_body_end_caret_is_one_protected_code_edit() {
    let source = "```Rust\r\na\r\n\r\n";
    let mut session = EditorSession::open(source);
    let mut view = ReferenceView::new("a\r\n");
    let mut accepts = 0;
    view.apply(
        session
            .replace_action(
                session.revision(),
                range(3, 3),
                "X",
                InputAction::Isolated,
                &mut |_| {
                    accepts += 1;
                    Ok(())
                },
            )
            .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(session.source_text(), "```Rust\r\na\r\nX\r\n");
    assert_eq!(view.text, "a\r\nX");
    assert_eq!(session.selection(), range(4, 4));
    assert!(session
        .project(session.revision(), range(4, 4))
        .unwrap()
        .blocks
        .iter()
        .all(|b| b.code));
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), source);
    assert_eq!(view.text, "a\r\n");
    view.apply(
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "```Rust\r\na\r\nX\r\n");
    assert_eq!(view.text, "a\r\nX");
}

#[test]
fn selected_internal_break_owns_only_its_retired_continuation_prefix() {
    for (inserted, expected, shown) in [
        ("", "> ```\n> ab\n> ```", "ab"),
        ("X", "> ```\n> aXb\n> ```", "aXb"),
    ] {
        let source = "> ```\n> a\n> b\n> ```";
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new("a\nb");
        view.apply(
            session
                .replace_action(
                    session.revision(),
                    range(1, 2),
                    inserted,
                    InputAction::Isolated,
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected);
        assert_eq!(view.text, shown);
        assert_eq!(
            session.selection(),
            range(1 + inserted.len(), 1 + inserted.len())
        );
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), source);
        assert_eq!(view.text, "a\nb");
    }
}

#[test]
fn selected_internal_crlf_delete_keys_retire_the_same_physical_prefix() {
    for eol in ["\n", "\r\n"] {
        for depth in 0..=2 {
            for closed in [false, true] {
                let prefix = "> ".repeat(depth);
                let tail = if closed {
                    format!("{eol}{prefix}```")
                } else {
                    eol.into()
                };
                let source = format!("{prefix}```{eol}{prefix}a{eol}{prefix}b{tail}");
                let expected = format!("{prefix}```{eol}{prefix}ab{tail}");
                for key in [ParagraphKey::Delete, ParagraphKey::Backspace] {
                    let mut session = EditorSession::open(&source);
                    let mut view = ReferenceView::new(&format!("a{eol}b"));
                    let at = if key == ParagraphKey::Delete {
                        1
                    } else {
                        1 + eol.len()
                    };
                    view.apply(
                        session
                            .paragraph_key(session.revision(), range(at, at), key, &mut |_| Ok(()))
                            .unwrap()
                            .unwrap(),
                    );
                    assert_eq!(session.source_text(), expected);
                    assert_eq!(session.selection(), range(1, 1));
                    assert_eq!(view.text, "ab");
                    assert_fresh_projection(&session, "ab");
                }
            }
        }
    }
}

#[test]
fn surviving_internal_break_keeps_its_different_physical_prefix_exact() {
    for (input, expected, display) in [
        ("\n", "> ```\n>\ta\n> b\n> ```", "a\nb"),
        ("X\n", "> ```\n>\taX\n> b\n> ```", "aX\nb"),
        ("\nX\n", "> ```\n>\ta\n>\tX\n> b\n> ```", "a\nX\nb"),
    ] {
        let source = "> ```\n>\ta\n> b\n> ```";
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new("a\nb");
        view.apply(
            session
                .replace_action(
                    session.revision(),
                    range(1, 2),
                    input,
                    InputAction::Isolated,
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected);
        assert_eq!(view.text, display);
        assert_fresh_projection(&session, display);
    }
}

#[test]
fn unchanged_os_and_explicit_breaks_preserve_physical_prefix_and_history_scope() {
    for eol in ["\n", "\r\n"] {
        let source = format!("> ```{eol}>\ta{eol}> b{eol}> ```");
        let shown = format!("a{eol}b");
        for os in [false, true] {
            let mut session = EditorSession::open(&source);
            let selected = range(1, 1 + eol.len());
            if os {
                assert!(session
                    .replace_os(Revision(0), selected, eol, &[], &mut |_| panic!(
                        "unchanged OS append"
                    ))
                    .unwrap()
                    .is_none());
            } else {
                let mut accepts = 0;
                let change = session
                    .replace_many(
                        Revision(0),
                        &[DisplayReplacement {
                            range: selected,
                            inserted: eol.into(),
                        }],
                        &mut |_| {
                            accepts += 1;
                            Ok(())
                        },
                    )
                    .unwrap();
                assert_eq!(accepts, 1);
                assert_eq!(change.revision, Revision(1));
            }
            assert_eq!(session.source_text(), source);
            assert_eq!(session.display_text(), shown);
            if os {
                assert_eq!(session.revision(), Revision(0));
                assert!(session
                    .undo(Revision(0), &mut |_| panic!("unchanged history"))
                    .unwrap()
                    .is_none());
            } else {
                assert!(session
                    .undo(session.revision(), &mut |_| Ok(()))
                    .unwrap()
                    .is_some());
                assert_eq!(session.source_text(), source);
            }
        }
    }
}

#[test]
fn crlf_replacement_and_explicit_unchanged_run_keep_the_following_prefix_spelling() {
    let source = "> ```\r\n>\ta\r\n> b\r\n> ```";
    let mut session = EditorSession::open(source);
    let mut view = ReferenceView::new("a\r\nb");
    view.apply(
        session
            .replace_action(
                Revision(0),
                range(1, 3),
                "\r\n",
                InputAction::Isolated,
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(session.source_text(), source);
    assert_eq!(view.text, "a\r\nb");
    let mut session = EditorSession::open(source);
    let mut view = ReferenceView::new("a\r\nb");
    view.apply(
        session
            .replace_many(
                Revision(0),
                &[
                    DisplayReplacement {
                        range: range(1, 3),
                        inserted: "\r\n".into(),
                    },
                    DisplayReplacement {
                        range: range(3, 4),
                        inserted: "B".into(),
                    },
                ],
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(session.source_text(), "> ```\r\n>\ta\r\n> B\r\n> ```");
    assert_eq!(view.text, "a\r\nB");
    assert_fresh_projection(&session, "a\r\nB");
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), source);
    assert_eq!(view.text, "a\r\nb");
}

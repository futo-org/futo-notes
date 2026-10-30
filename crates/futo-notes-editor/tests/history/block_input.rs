use super::*;
use futo_notes_editor::{Affinity, InputAction};

fn boundary_typing(
    source: &str,
    shown: &str,
    final_source: &str,
    final_display: &str,
    first_action: InputAction,
    groups: usize,
) {
    let clock = Arc::new(Clock::default());
    clock.0.store(10, Ordering::Relaxed);
    let mut session = EditorSession::open_with_clock(source, clock);
    let mut view = ReferenceView::new(shown);
    session
        .select_with_affinity(Revision(0), range(0, 0), Affinity::Forward)
        .unwrap();
    assert!(session
        .replace_action(Revision(0), range(0, 0), "!", first_action, &mut |_| Err(
            "blocked".into()
        ))
        .is_err());
    assert_eq!(session.source_text(), source);
    assert_eq!(session.revision(), Revision(0));
    assert!(session
        .undo(Revision(0), &mut |_| Ok(()))
        .unwrap()
        .is_none());
    let mut accepts = 0;
    for (inserted, action) in [("!", first_action), ("?", InputAction::Typing)] {
        view.apply(
            session
                .replace_action(
                    session.revision(),
                    session.selection(),
                    inserted,
                    action,
                    &mut |_| {
                        accepts += 1;
                        Ok(())
                    },
                )
                .unwrap(),
        );
    }
    assert_eq!(accepts, 2);
    assert_eq!(session.source_text(), final_source);
    assert_eq!(view.text, final_display);
    for _ in 0..groups {
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
    }
    assert_eq!(session.source_text(), source);
    assert_eq!(view.text, shown);
    assert_eq!(session.selection(), range(0, 0));
    assert_eq!(session.affinity(), Affinity::Forward);
    assert!(session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .is_none());
    for _ in 0..groups {
        view.apply(
            session
                .redo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
    }
    assert_eq!(session.source_text(), final_source);
    assert_eq!(view.text, final_display);
    assert!(session
        .redo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .is_none());
}

#[test]
fn ordinary_quote_boundary_repair_keeps_the_adjacent_typing_group() {
    boundary_typing(
        "> > \n> ab\n> ===",
        "\nab",
        "> > !?\n>\n> ab\n> ===",
        "!?\n\nab",
        InputAction::Typing,
        1,
    );
}

#[test]
fn ordinary_divider_edge_input_keeps_the_adjacent_typing_group() {
    boundary_typing(
        "---\n",
        "\u{fffc}\n",
        "!?\n***\n",
        "!?\n\u{fffc}\n",
        InputAction::Typing,
        1,
    );
}

#[test]
fn isolated_quote_boundary_repair_keeps_two_history_groups() {
    boundary_typing(
        "> > \n> ab\n> ===",
        "\nab",
        "> > !?\n>\n> ab\n> ===",
        "!?\n\nab",
        InputAction::Isolated,
        2,
    );
}

#[test]
fn legacy_composition_input_keeps_its_boundary_action_isolated() {
    boundary_typing(
        "> > \n> ab\n> ===",
        "\nab",
        "> > !?\n>\n> ab\n> ===",
        "!?\n\nab",
        InputAction::CompositionCommit,
        2,
    );
    boundary_typing(
        "---\n",
        "\u{fffc}\n",
        "!?\n***\n",
        "!?\n\u{fffc}\n",
        InputAction::CompositionCommit,
        2,
    );
}

#[test]
fn boundary_typing_groups_at_global_origins_both_divider_edges_and_crlf() {
    for (source, display, at, expected, shown) in [
        (
            "head __P__\r\n\r\n> > \n> ab\n> ===",
            "head P\r\n\r\n\nab",
            10,
            "head __P__\r\n\r\n> > !?\n>\n> ab\n> ===",
            "head P\r\n\r\n!?\n\nab",
        ),
        ("---\n", "\u{fffc}\n", 3, "---\n!?\n", "\u{fffc}\n!?\n"),
        (
            "> ---\n",
            "\u{fffc}\n",
            0,
            "> !?\n> ***\n",
            "!?\n\u{fffc}\n",
        ),
        (
            "> ---\n",
            "\u{fffc}\n",
            3,
            "> ---\n> !?\n",
            "\u{fffc}\n!?\n",
        ),
        (
            "> > \r\n> ab\r\n> ===",
            "\r\nab",
            0,
            "> > !?\r\n>\n> ab\r\n> ===",
            "!?\r\n\nab",
        ),
        (
            "> >  \n> ab\n> ===",
            " \nab",
            1,
            "> >  !?\n>\n> ab\n> ===",
            " !?\n\nab",
        ),
    ] {
        let mut session = EditorSession::open_with_clock(source, Arc::new(Clock::default()));
        let mut view = ReferenceView::new(display);
        assert_eq!(session.display_text(), display);
        session
            .select_with_affinity(Revision(0), range(at, at), Affinity::Forward)
            .unwrap();
        for inserted in ["!", "?"] {
            view.apply(
                session
                    .replace(
                        session.revision(),
                        session.selection(),
                        inserted,
                        &mut |_| Ok(()),
                    )
                    .unwrap(),
            );
        }
        assert_eq!(session.source_text(), expected);
        assert_eq!(view.text, shown);
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), source);
        assert_eq!(session.selection(), range(at, at));
        assert_eq!(session.affinity(), Affinity::Forward);
        assert_eq!(view.text, display);
        assert!(session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .is_none());
        view.apply(
            session
                .redo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected);
        assert_eq!(view.text, shown);
    }
}

#[test]
fn plain_adjacent_typing_control() {
    boundary_typing("ab", "ab", "!?ab", "!?ab", InputAction::Typing, 1);
}

#[test]
fn typing_into_the_quote_repair_joins_the_preexisting_whitespace_run() {
    let mut session =
        EditorSession::open_with_clock("> > \n> ab\n> ===", Arc::new(Clock::default()));
    let mut view = ReferenceView::new("\nab");
    for inserted in [" ", "!", "?"] {
        view.apply(
            session
                .replace(
                    session.revision(),
                    session.selection(),
                    inserted,
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
    }
    assert_eq!(session.source_text(), "> >  !?\n>\n> ab\n> ===");
    assert_eq!(view.text, " !?\n\nab");
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "> > \n> ab\n> ===");
    assert_eq!(view.text, "\nab");
    assert!(session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .is_none());
    view.apply(
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "> >  !?\n>\n> ab\n> ===");
}

#[test]
fn boundary_input_obeys_clock_selection_and_grapheme_group_boundaries() {
    for (first, time, moved, groups) in [
        ("!", 499, false, 1),
        ("!", 510, false, 2),
        ("!", 9, false, 2),
        ("!", 10, true, 2),
        ("e\u{301}", 10, false, 1),
        ("!!", 10, false, 2),
        ("!\n", 10, false, 2),
    ] {
        for source in ["> > \n> ab\n> ===", "---\n"] {
            let clock = Arc::new(Clock::default());
            clock.0.store(10, Ordering::Relaxed);
            let mut session = EditorSession::open_with_clock(source, clock.clone());
            let original_formats = session.active_formats();
            session
                .replace(session.revision(), session.selection(), first, &mut |_| {
                    Ok(())
                })
                .unwrap();
            let intermediate = session.source_text();
            if moved {
                let caret = session.selection();
                session
                    .select_with_affinity(session.revision(), caret, Affinity::Backward)
                    .unwrap();
                session
                    .select_with_affinity(session.revision(), caret, Affinity::Forward)
                    .unwrap();
            }
            clock.0.store(time, Ordering::Relaxed);
            session
                .replace(
                    session.revision(),
                    session.selection(),
                    "?",
                    &mut |_| Ok(()),
                )
                .unwrap();
            let final_source = session.source_text();
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            if groups == 2 {
                assert_eq!(
                    session.source_text(),
                    intermediate,
                    "{source:?}/{first:?}/{time}/{moved}"
                );
                session
                    .undo(session.revision(), &mut |_| Ok(()))
                    .unwrap()
                    .unwrap();
            }
            assert_eq!(
                session.source_text(),
                source,
                "{source:?}/{first:?}/{time}/{moved}"
            );
            assert_eq!(session.active_formats(), original_formats);
            assert!(session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .is_none());
            for _ in 0..groups {
                session
                    .redo(session.revision(), &mut |_| Ok(()))
                    .unwrap()
                    .unwrap();
            }
            assert_eq!(session.source_text(), final_source);
        }
    }
}

#[test]
fn boundary_input_retains_explicit_bold_and_code_through_grouped_history() {
    use futo_notes_editor::InlineFormat;
    for (source, format, final_source) in [
        (
            "> > \n> ab\n> ===",
            InlineFormat::Bold,
            "> > **!?**\n>\n> ab\n> ===",
        ),
        (
            "> > \n> ab\n> ===",
            InlineFormat::Code,
            "> > `!?`\n>\n> ab\n> ===",
        ),
        ("---\n", InlineFormat::Bold, "**!?**\n***\n"),
        ("---\n", InlineFormat::Code, "`!?`\n***\n"),
    ] {
        let mut session = EditorSession::open_with_clock(source, Arc::new(Clock::default()));
        assert!(session
            .toggle_format(session.revision(), format, &mut |_| Ok(()))
            .unwrap()
            .is_none());
        for inserted in ["!", "?"] {
            session
                .replace(
                    session.revision(),
                    session.selection(),
                    inserted,
                    &mut |_| Ok(()),
                )
                .unwrap();
            assert_eq!(
                session.active_formats(),
                vec![format],
                "{source:?}/{format:?}/{inserted:?}"
            );
        }
        assert_eq!(session.source_text(), final_source);
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), source);
        assert_eq!(session.active_formats(), vec![format]);
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), final_source);
        assert_eq!(session.active_formats(), vec![format]);
    }
}

#[test]
fn rejected_boundary_input_preserves_the_existing_run_for_retry() {
    let source = "> > \n> ab\n> ===";
    let mut session = EditorSession::open_with_clock(source, Arc::new(Clock::default()));
    session
        .replace(
            session.revision(),
            session.selection(),
            " ",
            &mut |_| Ok(()),
        )
        .unwrap();
    let revision = session.revision();
    let selection = session.selection();
    assert!(session
        .replace(revision, selection, "!", &mut |_| Err("full".into()))
        .is_err());
    assert_eq!(session.source_text(), "> >  \n> ab\n> ===");
    assert_eq!(session.revision(), revision);
    assert_eq!(session.selection(), selection);
    for inserted in ["!", "?"] {
        session
            .replace(
                session.revision(),
                session.selection(),
                inserted,
                &mut |_| Ok(()),
            )
            .unwrap();
    }
    session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), source);
    assert!(session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .is_none());
}

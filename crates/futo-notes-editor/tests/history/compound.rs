use super::*;

#[test]
fn multi_run_command_preserves_unchanged_spelling_and_is_one_atomic_history_action() {
    use futo_notes_editor::{Affinity, DisplayReplacement, InlineFormat};
    let opening = "__cat__ & _dog_  \r\n";
    let mut session = EditorSession::open_with_clock(opening, Arc::new(Clock::default()));
    let mut view = ReferenceView::new("cat & dog  \r\n");
    session
        .select_with_affinity(Revision(0), range(0, 9), Affinity::Forward)
        .unwrap();
    let replacements = [
        DisplayReplacement {
            range: range(0, 3),
            inserted: "kitten".into(),
        },
        DisplayReplacement {
            range: range(6, 9),
            inserted: "ox".into(),
        },
    ];
    let mut calls = 0;
    assert!(session
        .replace_many(Revision(0), &replacements, &mut |_| {
            calls += 1;
            Err("full".into())
        })
        .is_err());
    assert_eq!(calls, 1);
    assert_eq!(session.source_text(), opening);
    assert_eq!(session.selection(), range(0, 9));
    assert!(session
        .undo(Revision(0), &mut |_| Ok(()))
        .unwrap()
        .is_none());
    view.apply(
        session
            .replace_many(Revision(0), &replacements, &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), "__kitten__ & _ox_  \r\n");
    assert_eq!(view.text, "kitten & ox  \r\n");
    assert_eq!(session.selection(), range(11, 11));
    assert_eq!(session.active_formats(), vec![InlineFormat::Italic]);
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), opening);
    assert_eq!(session.selection(), range(0, 9));
    assert_eq!(session.affinity(), Affinity::Forward);
    assert!(session
        .undo(Revision(2), &mut |_| Ok(()))
        .unwrap()
        .is_none());
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "__kitten__ & _ox_  \r\n");
    assert_eq!(view.text, "kitten & ox  \r\n");
}

#[test]
fn invalid_multi_run_foreign_input_rejects_the_whole_action_before_acceptance() {
    use futo_notes_editor::{
        DisplayUtf16Offset, DisplayUtf16Range, DisplayUtf16Replacement, EditorError,
    };
    let mut session = EditorSession::open_with_clock("__😀ab__", Arc::new(Clock::default()));
    let utf16 = |a, z| DisplayUtf16Range {
        start: DisplayUtf16Offset(a),
        end: DisplayUtf16Offset(z),
    };
    for (second, expected) in [
        (
            DisplayUtf16Replacement {
                range: utf16(2, 3),
                inserted: vec![0xd800],
            },
            EditorError::InvalidText,
        ),
        (
            DisplayUtf16Replacement {
                range: utf16(1, 2),
                inserted: vec![120],
            },
            EditorError::InvalidRange,
        ),
        (
            DisplayUtf16Replacement {
                range: utf16(0, 2),
                inserted: vec![120],
            },
            EditorError::InvalidRange,
        ),
    ] {
        let mut calls = 0;
        assert_eq!(
            session.replace_many_utf16(
                Revision(0),
                &[
                    DisplayUtf16Replacement {
                        range: utf16(0, 2),
                        inserted: vec![97]
                    },
                    second
                ],
                &mut |_| {
                    calls += 1;
                    Ok(())
                }
            ),
            Err(expected)
        );
        assert_eq!(calls, 0);
        assert_eq!(session.source_text(), "__😀ab__");
        assert!(session
            .undo(Revision(0), &mut |_| Ok(()))
            .unwrap()
            .is_none());
    }
}

#[test]
fn grouping_does_not_materialize_a_growing_run_or_an_unrelated_note_prefix() {
    use futo_notes_editor::DisplayReplacement;
    let prefix = "unchanged\n\n".repeat(2000);
    let opening = format!("{prefix}__a__ & _b_");
    let at = prefix.len();
    let mut session = EditorSession::open_with_clock(&opening, Arc::new(Clock::default()));
    for index in 0..30 {
        let change = session
            .replace(
                session.revision(),
                range(at + 1 + index, at + 1 + index),
                "x",
                &mut |_| Ok(()),
            )
            .unwrap();
        assert!(
            change.work.materialized_source_bytes < 1500,
            "{:#?}",
            change.work
        );
        assert!(change.work.parsed_source_bytes < 1500, "{:#?}", change.work);
    }
    session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), opening);
    let change = session
        .replace_many(
            session.revision(),
            &[
                DisplayReplacement {
                    range: range(at, at + 1),
                    inserted: "long".into(),
                },
                DisplayReplacement {
                    range: range(at + 4, at + 5),
                    inserted: "short".into(),
                },
            ],
            &mut |_| Ok(()),
        )
        .unwrap();
    assert!(
        change.work.materialized_source_bytes < 1500,
        "{:#?}",
        change.work
    );
    assert!(change.work.parsed_source_bytes < 1500, "{:#?}", change.work);
    assert_eq!(
        session.source_text(),
        format!("{prefix}__long__ & _short_")
    );
    session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), opening);
}

#[test]
fn mixed_format_selection_multi_run_and_typing_history_returns_to_opening_and_final_bytes() {
    use futo_notes_editor::{Affinity, DisplayReplacement, InlineFormat};
    let opening = "__cat__ & _dog_\r\n";
    let mut session = EditorSession::open_with_clock(opening, Arc::new(Clock::default()));
    let mut view = ReferenceView::new("cat & dog\r\n");
    session
        .select_with_affinity(Revision(0), range(0, 3), Affinity::Forward)
        .unwrap();
    view.apply(
        session
            .toggle_format(Revision(0), InlineFormat::Italic, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "*__cat__* & _dog_\r\n");
    view.apply(
        session
            .replace_many(
                Revision(1),
                &[
                    DisplayReplacement {
                        range: range(0, 3),
                        inserted: "kitten".into(),
                    },
                    DisplayReplacement {
                        range: range(6, 9),
                        inserted: "ox".into(),
                    },
                ],
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(session.source_text(), "*__kitten__* & _ox_\r\n");
    view.apply(
        session
            .replace(Revision(2), range(11, 11), "!", &mut |_| Ok(()))
            .unwrap(),
    );
    view.apply(
        session
            .replace(Revision(3), range(12, 12), "?", &mut |_| Ok(()))
            .unwrap(),
    );
    let final_bytes = "*__kitten__* & _ox!?_\r\n";
    assert_eq!(session.source_text(), final_bytes);
    for expected in [
        "*__kitten__* & _ox_\r\n",
        "*__cat__* & _dog_\r\n",
        opening,
    ] {
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected);
        assert_eq!(session.display_text(), view.text);
    }
    assert_eq!(session.selection(), range(0, 3));
    assert_eq!(session.affinity(), Affinity::Forward);
    assert!(session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .is_none());
    for expected in [
        "*__cat__* & _dog_\r\n",
        "*__kitten__* & _ox_\r\n",
        final_bytes,
    ] {
        view.apply(
            session
                .redo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected);
        assert_eq!(session.display_text(), view.text);
    }
    assert_eq!(session.selection(), range(13, 13));
    assert_eq!(session.active_formats(), vec![InlineFormat::Italic]);
}

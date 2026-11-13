mod common;
use common::ReferenceView;
use futo_notes_editor::*;

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[test]
fn explicit_runs_during_composition_delete_the_selected_space() {
    let source = "a  b c";
    let mut session = EditorSession::open(source);
    let mut view = ReferenceView::new("a  b c");
    session.select(Revision(0), range(5, 6)).unwrap();
    let marked = session.compose(Revision(0), range(5, 6), "C").unwrap();
    let replacements = [
        DisplayReplacement {
            range: range(1, 2),
            inserted: "".into(),
        },
        DisplayReplacement {
            range: range(3, 4),
            inserted: "B".into(),
        },
    ];
    let mut calls = 0;
    assert_eq!(
        session.replace_many(Revision(0), &replacements, &mut |_| {
            calls += 1;
            Err("disk full".into())
        }),
        Err(EditorError::Persistence("disk full".into()))
    );
    assert_eq!(calls, 1);
    assert_eq!(session.source_text(), source);
    assert_eq!(session.revision(), Revision(0));
    assert_eq!(session.selection(), range(5, 6));
    assert_eq!(session.composition(), Some(&marked));
    assert!(session
        .undo(Revision(0), &mut |_| panic!("pending composition"))
        .unwrap()
        .is_none());

    calls = 0;
    let change = session
        .replace_many(Revision(0), &replacements, &mut |_| {
            calls += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(calls, 1);
    assert_eq!(change.selection, range(3, 3));
    view.apply(change);
    assert_eq!(session.source_text(), "a B C");
    assert_eq!(view.text, "a B C");
    assert!(session.composition().is_none());
    assert_eq!(
        session
            .display_to_utf16(session.revision(), session.selection())
            .unwrap(),
        DisplayUtf16Range {
            start: DisplayUtf16Offset(3),
            end: DisplayUtf16Offset(3),
        }
    );

    for (expected_source, expected_display, selection) in [
        ("a  b C", "a  b C", range(6, 6)),
        (source, "a  b c", range(5, 6)),
    ] {
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected_source);
        assert_eq!(view.text, expected_display);
        assert_eq!(session.selection(), selection);
    }
    for (expected_source, expected_display, selection) in [
        ("a  b C", "a  b C", range(6, 6)),
        ("a B C", "a B C", range(3, 3)),
    ] {
        view.apply(
            session
                .redo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), expected_source);
        assert_eq!(view.text, expected_display);
        assert_eq!(session.selection(), selection);
    }
}

#[test]
fn explicit_composition_runs_keep_the_unselected_one_of_equal_scalars() {
    // The unselected scalar keeps its spelling, even when its glyph equals a selected
    // neighbor (`!` beside `\!`). All ranges address the raw provisional view.
    for (
        source,
        display,
        mark,
        marked,
        committed,
        committed_display,
        runs,
        expected,
        shown,
        caret,
    ) in [
        (
            "a  b c",
            "a  b c",
            (5, 6),
            "c",
            "a  b c",
            "a  b c",
            vec![(1, 2, ""), (3, 4, "B")],
            "a B c",
            "a B c",
            3,
        ),
        (
            "a!\\! b c",
            "a!! b c",
            (6, 7),
            "C",
            "a!\\! b C",
            "a!! b C",
            vec![(1, 2, ""), (4, 5, "B")],
            "a\\! B C",
            "a! B C",
            4,
        ),
        (
            "a\\!! b c",
            "a!! b c",
            (6, 7),
            "C",
            "a\\!! b C",
            "a!! b C",
            vec![(1, 2, ""), (4, 5, "B")],
            "a! B C",
            "a! B C",
            4,
        ),
        (
            "a😀😀 b c",
            "a😀😀 b c",
            (12, 13),
            "C",
            "a😀😀 b C",
            "a😀😀 b C",
            vec![(1, 5, ""), (10, 11, "B")],
            "a😀 B C",
            "a😀 B C",
            7,
        ),
        (
            "a  b c",
            "a  b c",
            (0, 1),
            "A",
            "A  b c",
            "A  b c",
            vec![(1, 2, ""), (3, 4, "B")],
            "A B c",
            "A B c",
            3,
        ),
        (
            "a  b c",
            "a  b c",
            (1, 2),
            "!",
            "a! b c",
            "a! b c",
            vec![(1, 2, ""), (3, 4, "B")],
            "a B c",
            "a B c",
            3,
        ),
        (
            "a  b c",
            "a  b c",
            (2, 3),
            "\t",
            "a \tb c",
            "a \tb c",
            vec![(1, 2, ""), (3, 4, "B")],
            "a\tB c",
            "a\tB c",
            3,
        ),
        (
            "a  b c",
            "a  b c",
            (3, 4),
            "bb",
            "a  bb c",
            "a  bb c",
            vec![(1, 2, ""), (3, 5, "B")],
            "a B c",
            "a B c",
            3,
        ),
        (
            "> x\n> a  b",
            "x\na  b",
            (0, 1),
            "X",
            "> X\n> a  b",
            "X\na  b",
            vec![(3, 4, ""), (5, 6, "B")],
            "> X\n> a B",
            "X\na B",
            5,
        ),
        (
            "a  b\n\n> x\n> c  d",
            "a  b\n\nx\nc  d",
            (6, 7),
            "X",
            "a  b\n\n> X\n> c  d",
            "a  b\n\nX\nc  d",
            vec![(1, 2, ""), (3, 4, "B"), (9, 10, ""), (11, 12, "D")],
            "a B\n\n> X\n> c D",
            "a B\n\nX\nc D",
            10,
        ),
    ] {
        for prefix in ["", "遠方😀\n\none\n\ntwo\n\n"] {
            let offset = prefix.len();
            let source = format!("{prefix}{source}\n\ntail");
            let display = format!("{prefix}{display}\n\ntail");
            let committed = format!("{prefix}{committed}\n\ntail");
            let committed_display = format!("{prefix}{committed_display}\n\ntail");
            let mut session = EditorSession::open(&source);
            let mut view = ReferenceView::new(&display);
            session
                .compose(Revision(0), range(offset + mark.0, offset + mark.1), marked)
                .unwrap();
            let replacements: Vec<_> = runs
                .iter()
                .map(|&(start, end, text)| DisplayReplacement {
                    range: range(offset + start, offset + end),
                    inserted: text.into(),
                })
                .collect();
            let mut calls = 0;
            view.apply(
                session
                    .replace_many(Revision(0), &replacements, &mut |_| {
                        calls += 1;
                        Ok(())
                    })
                    .unwrap(),
            );
            assert_eq!(calls, 1, "{source}");
            assert_eq!(
                session.source_text(),
                format!("{prefix}{expected}\n\ntail"),
                "{source}"
            );
            assert_eq!(view.text, format!("{prefix}{shown}\n\ntail"), "{source}");
            assert_eq!(
                session.selection(),
                range(offset + caret, offset + caret),
                "{source}"
            );
            let accepted = session.source_text();
            view.apply(
                session
                    .undo(session.revision(), &mut |_| Ok(()))
                    .unwrap()
                    .unwrap(),
            );
            assert_eq!(session.source_text(), committed, "{source}");
            assert_eq!(view.text, committed_display, "{source}");
            if source != committed {
                view.apply(
                    session
                        .undo(session.revision(), &mut |_| Ok(()))
                        .unwrap()
                        .unwrap(),
                );
                assert_eq!(session.source_text(), source);
                assert_eq!(view.text, display);
                view.apply(
                    session
                        .redo(session.revision(), &mut |_| Ok(()))
                        .unwrap()
                        .unwrap(),
                );
            }
            view.apply(
                session
                    .redo(session.revision(), &mut |_| Ok(()))
                    .unwrap()
                    .unwrap(),
            );
            assert_eq!(session.source_text(), accepted);
            assert_eq!(session.selection(), range(offset + caret, offset + caret));
        }
    }
}

#[test]
fn unchanged_explicit_runs_do_not_add_history_after_a_changed_marked_commit() {
    for (selected, inserted) in [(range(3, 4), "b"), (range(1, 2), " ")] {
        let mut session = EditorSession::open("a  b c");
        let mut view = ReferenceView::new("a  b c");
        let marked = session.compose(Revision(0), range(5, 6), "C").unwrap();
        assert_eq!(
            session.replace_many(Revision(0), &[], &mut |_| panic!("empty batch")),
            Err(EditorError::InvalidRange)
        );
        assert_eq!(session.composition(), Some(&marked));
        let replacements = [DisplayReplacement {
            range: selected,
            inserted: inserted.into(),
        }];
        let mut calls = 0;
        assert_eq!(
            session.replace_many(Revision(0), &replacements, &mut |_| {
                calls += 1;
                Err("disk full".into())
            }),
            Err(EditorError::Persistence("disk full".into()))
        );
        assert_eq!(calls, 1);
        assert_eq!(session.source_text(), "a  b c");
        assert_eq!(session.composition(), Some(&marked));
        calls = 0;
        view.apply(
            session
                .replace_many(Revision(0), &replacements, &mut |_| {
                    calls += 1;
                    Ok(())
                })
                .unwrap(),
        );
        assert_eq!(calls, 1);
        assert_eq!(session.source_text(), "a  b C");
        assert_eq!(view.text, "a  b C");
        assert_eq!(session.selection(), range(selected.end.0, selected.end.0));
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), "a  b c");
        assert_eq!(view.text, "a  b c");
        assert!(session
            .undo(session.revision(), &mut |_| panic!(
                "no phantom following group"
            ))
            .unwrap()
            .is_none());
        view.apply(
            session
                .redo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), "a  b C");
        assert_eq!(session.selection(), range(6, 6));
    }
}

#[test]
fn unchanged_marking_and_explicit_runs_write_nothing() {
    let mut session = EditorSession::open("a  b c");
    let marked = session.compose(Revision(0), range(5, 6), "c").unwrap();
    assert_eq!(
        session.replace_many(Revision(0), &[], &mut |_| panic!("empty batch")),
        Err(EditorError::InvalidRange)
    );
    let unchanged = DisplayReplacement {
        range: range(1, 2),
        inserted: " ".into(),
    };
    assert_eq!(
        session.replace_many(
            Revision(0),
            &[
                unchanged.clone(),
                DisplayReplacement {
                    range: range(99, 100),
                    inserted: "x".into()
                }
            ],
            &mut |_| panic!("invalid later range")
        ),
        Err(EditorError::InvalidRange)
    );
    assert_eq!(session.composition(), Some(&marked));
    assert_eq!(session.source_text(), "a  b c");
    // A batch that changes nothing commits the marking and moves the caret, but
    // writes nothing and leaves no undo step: undo replays text edits, and there are none.
    let change = session
        .replace_many(Revision(0), &[unchanged], &mut |_| panic!("nothing to save"))
        .unwrap();
    assert_eq!(change.selection, range(2, 2));
    assert_eq!(session.source_text(), "a  b c");
    assert!(session.composition().is_none());
    assert!(session
        .undo(session.revision(), &mut |_| panic!("no empty action"))
        .unwrap()
        .is_none());
    assert!(session
        .commit_composition(session.revision(), None, &mut |_| panic!("repeated commit"))
        .unwrap()
        .is_none());
}

#[test]
fn unchanged_explicit_runs_keep_source_identity_and_the_final_supplied_caret() {
    for marked in ["C", "c"] {
        let mut session = EditorSession::open("a  b c");
        let mut view = ReferenceView::new("a  b c");
        session.compose(Revision(0), range(5, 6), marked).unwrap();
        view.apply(
            session
                .replace_many(
                    Revision(0),
                    &[
                        DisplayReplacement {
                            range: range(1, 2),
                            inserted: " ".into(),
                        },
                        DisplayReplacement {
                            range: range(3, 4),
                            inserted: "B".into(),
                        },
                        DisplayReplacement {
                            range: range(5, 6),
                            inserted: marked.into(),
                        },
                    ],
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        assert_eq!(session.source_text(), format!("a  B {marked}"));
        assert_eq!(view.text, format!("a  B {marked}"));
        assert_eq!(session.selection(), range(6, 6));
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), format!("a  b {marked}"));
        if marked == "C" {
            view.apply(
                session
                    .undo(session.revision(), &mut |_| Ok(()))
                    .unwrap()
                    .unwrap(),
            );
        }
        assert_eq!(session.source_text(), "a  b c");
        assert_eq!(view.text, "a  b c");
    }
}

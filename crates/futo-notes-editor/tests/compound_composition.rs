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
fn explicit_runs_during_composition_delete_the_selected_entity_space() {
    let source = "a&#32; b c";
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
        ("a&#32; b C", "a  b C", range(6, 6)),
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
        ("a&#32; b C", "a  b C", range(6, 6)),
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
fn explicit_composition_runs_retain_equal_visible_scalars_with_distinct_source_spelling() {
    // Worked literal sources keep the unselected scalar, even when its glyph
    // equals a selected neighbor. All ranges address the raw provisional view.
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
            "a&#32; b c",
            "a  b c",
            (5, 6),
            "c",
            "a&#32; b c",
            "a  b c",
            vec![(1, 2, ""), (3, 4, "B")],
            "a B c",
            "a B c",
            3,
        ),
        (
            "a &#32;b c",
            "a  b c",
            (5, 6),
            "C",
            "a &#32;b C",
            "a  b C",
            vec![(1, 2, ""), (3, 4, "B")],
            "a&#32;B C",
            "a B C",
            3,
        ),
        (
            "a&#32;&#x20;b c",
            "a  b c",
            (5, 6),
            "C",
            "a&#32;&#x20;b C",
            "a  b C",
            vec![(1, 2, ""), (3, 4, "B")],
            "a&#x20;B C",
            "a B C",
            3,
        ),
        (
            "a&#33;\\! b c",
            "a!! b c",
            (6, 7),
            "C",
            "a&#33;\\! b C",
            "a!! b C",
            vec![(1, 2, ""), (4, 5, "B")],
            "a\\! B C",
            "a! B C",
            4,
        ),
        (
            "a\\!&#33; b c",
            "a!! b c",
            (6, 7),
            "C",
            "a\\!&#33; b C",
            "a!! b C",
            vec![(1, 2, ""), (4, 5, "B")],
            "a&#33; B C",
            "a! B C",
            4,
        ),
        (
            "a&#x1f600;😀 b c",
            "a😀😀 b c",
            (12, 13),
            "C",
            "a&#x1f600;😀 b C",
            "a😀😀 b C",
            vec![(1, 5, ""), (10, 11, "B")],
            "a😀 B C",
            "a😀 B C",
            7,
        ),
        (
            "a&#32; b c",
            "a  b c",
            (0, 1),
            "A",
            "A&#32; b c",
            "A  b c",
            vec![(1, 2, ""), (3, 4, "B")],
            "A B c",
            "A B c",
            3,
        ),
        (
            "a&#32; b c",
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
            "a&#32; b c",
            "a  b c",
            (2, 3),
            "\t",
            "a&#32;\tb c",
            "a \tb c",
            vec![(1, 2, ""), (3, 4, "B")],
            "a\tB c",
            "a\tB c",
            3,
        ),
        (
            "a&#32; b c",
            "a  b c",
            (3, 4),
            "bb",
            "a&#32; bb c",
            "a  bb c",
            vec![(1, 2, ""), (3, 5, "B")],
            "a B c",
            "a B c",
            3,
        ),
        (
            "> > \n> a&#32; b\n> =",
            "\na  b",
            (0, 0),
            "!",
            "> > !\n>\n> a&#32; b\n> =",
            "!\n\na  b",
            vec![(3, 4, ""), (5, 6, "B")],
            "> > !\n>\n> a B\n> =",
            "!\n\na B",
            6,
        ),
        (
            "a&#32; b\n\n> > \n> c&#32; d\n> =",
            "a  b\n\n\nc  d",
            (6, 6),
            "!",
            "a&#32; b\n\n> > !\n>\n> c&#32; d\n> =",
            "a  b\n\n!\n\nc  d",
            vec![(1, 2, ""), (3, 4, "B"), (9, 10, ""), (11, 12, "D")],
            "a B\n\n> > !\n>\n> c D\n> =",
            "a B\n\n!\n\nc D",
            11,
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

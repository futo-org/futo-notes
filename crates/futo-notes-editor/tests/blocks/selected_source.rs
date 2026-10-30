use super::*;

#[test]
fn a_whole_explicit_selection_can_retire_its_selected_lower_heading() {
    let original = "> > !\n>\n> ab\n> ===";
    let mut s = EditorSession::open(original);
    let mut view = ReferenceView::new("!\n\nab");
    let selected = range(0, 5);
    s.select_with_affinity(s.revision(), selected, Affinity::Forward)
        .unwrap();
    let replacement = DisplayReplacement {
        range: selected,
        inserted: "!\nAC".into(),
    };
    assert_eq!(
        s.replace_many(
            s.revision(),
            std::slice::from_ref(&replacement),
            &mut |_| { Err("blocked".into()) }
        ),
        Err(EditorError::Persistence("blocked".into()))
    );
    assert_eq!(s.source_text(), original);
    assert_eq!(s.display_text(), view.text);
    assert_eq!(s.revision(), Revision(0));
    assert_eq!(s.selection(), selected);
    assert!(s.undo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
    let mut accepts = 0;
    let change = s
        .replace_many(s.revision(), &[replacement], &mut |_| {
            accepts += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(accepts, 1);
    assert_eq!(change.selection, range(4, 4));
    view.apply(change);
    assert_eq!(s.source_text(), "> > !\nAC");
    assert_eq!(view.text, "!\nAC");
    assert_eq!(s.display_text(), view.text);
    assert_eq!(
        s.display_to_utf16(s.revision(), s.selection()).unwrap(),
        DisplayUtf16Range {
            start: DisplayUtf16Offset(4),
            end: DisplayUtf16Offset(4),
        }
    );
    assert!(s
        .project(s.revision(), range(0, 4))
        .unwrap()
        .blocks
        .iter()
        .all(|block| block.heading == 0));
    assert_eq!(EditorSession::open("> > !\nAC").display_text(), view.text);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), original);
    assert_eq!(view.text, "!\n\nab");
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Forward);
    assert!(s.undo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "> > !\nAC");
    assert_eq!(view.text, "!\nAC");
    assert_eq!(s.selection(), range(4, 4));
    assert!(s.redo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
}

#[test]
fn selected_lower_heading_retirement_is_shared_by_direct_and_explicit_input() {
    for (raw, shown, inserted, expected) in [
        ("> > !\n>\n> ab\n> ===", "!\n\nab", "!\nAC", "> > !\nAC"),
        (
            "> > !\r\n>\r\n> ab\r\n> ===",
            "!\r\n\r\nab",
            "!\r\nAC",
            "> > !\r\nAC",
        ),
    ] {
        for (prefix, prefix_display, tail, tail_display) in [
            ("", "", "", ""),
            (
                "prefix&#33;\r\n\r\n",
                "prefix!\r\n\r\n",
                "\r\n\r\nuntouched&#32;tail\r\n",
                "\r\n\r\nuntouched tail\r\n",
            ),
        ] {
            for explicit in [false, true] {
                let original = format!("{prefix}{raw}{tail}");
                let opening = format!("{prefix_display}{shown}{tail_display}");
                let mut s = EditorSession::open(&original);
                let mut view = ReferenceView::new(&opening);
                assert_eq!(s.display_text(), opening);
                let start = prefix_display.len();
                let selected = range(start, start + shown.len());
                s.select_with_affinity(s.revision(), selected, Affinity::Forward)
                    .unwrap();
                let mut accepts = 0;
                let mut accept = |_: &SourceEdit| {
                    accepts += 1;
                    Ok(())
                };
                let change = if explicit {
                    s.replace_many(
                        s.revision(),
                        &[DisplayReplacement {
                            range: selected,
                            inserted: inserted.into(),
                        }],
                        &mut accept,
                    )
                } else {
                    s.replace_action(
                        s.revision(),
                        selected,
                        inserted,
                        InputAction::Isolated,
                        &mut accept,
                    )
                }
                .unwrap();
                assert_eq!(accepts, 1);
                view.apply(change);
                let committed = format!("{prefix}{expected}{tail}");
                let display = format!("{prefix_display}{inserted}{tail_display}");
                assert_eq!(s.source_text(), committed);
                assert_eq!(view.text, display);
                assert_eq!(
                    s.selection(),
                    range(start + inserted.len(), start + inserted.len())
                );
                assert_eq!(EditorSession::open(&committed).display_text(), display);
                let native = s.display_to_utf16(s.revision(), s.selection()).unwrap();
                assert_eq!(native.end.0, start + inserted.len());
                view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
                assert_eq!(s.source_text(), original);
                assert_eq!(view.text, opening);
                assert_eq!(s.selection(), selected);
                assert!(s.undo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
                view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
                assert_eq!(s.source_text(), committed);
                assert_eq!(view.text, display);
                assert!(s.redo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
            }
        }
    }
}

#[test]
fn lower_heading_retirement_respects_partial_body_and_separator_only_selections() {
    let raw = "> > !\n>\n> ab\n> ===";
    for (selected, inserted, expected, shown, caret) in [
        (range(1, 5), "\nAC", "> > !\nAC", "!\nAC", 4),
        (range(0, 5), "!\n\nAC", "> > !\n\nAC", "!\n\nAC", 5),
        (range(3, 5), "AC", "> > !\n>\n> AC\n> ===", "!\n\nAC", 5),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new("!\n\nab");
        view.apply(
            s.replace_many(
                s.revision(),
                &[DisplayReplacement {
                    range: selected,
                    inserted: inserted.into(),
                }],
                &mut |_| Ok(()),
            )
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(caret, caret));
        assert_eq!(EditorSession::open(expected).display_text(), shown);
    }
    for (selected, inserted) in [(range(2, 5), "AC"), (range(0, 4), "!\nA")] {
        let mut s = EditorSession::open(raw);
        s.select(s.revision(), selected).unwrap();
        assert_eq!(
            s.replace_many(
                s.revision(),
                &[DisplayReplacement {
                    range: selected,
                    inserted: inserted.into(),
                }],
                &mut |_| panic!("unselected structure must not change")
            ),
            Err(EditorError::UnrepresentableFormat)
        );
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.display_text(), "!\n\nab");
        assert_eq!(s.selection(), selected);
        assert_eq!(s.revision(), Revision(0));
        assert!(s.undo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
    }
}

#[test]
fn raw_composition_keeps_source_until_explicit_selected_body_input() {
    let raw = "> > !\n>\n> ab\n> ===";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("!\n\nab");
    let selected = range(0, 5);
    s.select(s.revision(), selected).unwrap();
    for text in ["!\nA", "!\nAC"] {
        let marked = s.compose(s.revision(), selected, text).unwrap();
        assert_eq!(marked.text, text);
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.display_text(), view.text);
        assert_eq!(s.revision(), Revision(0));
    }
    s.cancel_composition(s.revision()).unwrap();
    assert_eq!(s.source_text(), raw);
    assert!(s.undo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
    let marked = s.compose(s.revision(), selected, "!\n\nab").unwrap();
    let replacement = DisplayReplacement {
        range: selected,
        inserted: "!\nAC".into(),
    };
    assert_eq!(
        s.replace_many(
            s.revision(),
            std::slice::from_ref(&replacement),
            &mut |_| Err("blocked".into())
        ),
        Err(EditorError::Persistence("blocked".into()))
    );
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.revision(), Revision(0));
    assert_eq!(s.composition(), Some(&marked));
    let mut accepts = 0;
    view.apply(
        s.replace_many(s.revision(), &[replacement], &mut |_| {
            accepts += 1;
            Ok(())
        })
        .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(s.source_text(), "> > !\nAC");
    assert_eq!(view.text, "!\nAC");
    assert_eq!(s.selection(), range(4, 4));
    assert!(s.composition().is_none());
    assert!(s
        .commit_composition(s.revision(), None, &mut |_| panic!("repeated commit"))
        .unwrap()
        .is_none());
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), selected);
    assert_eq!(view.text, "!\n\nab");
    assert!(s.undo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "> > !\nAC");
    assert_eq!(view.text, "!\nAC");
}

#[test]
fn changed_marking_and_whole_explicit_input_retire_only_the_selected_heading() {
    let original = "> > \n> ab\n> ===";
    let committed_marking = "> > !\n>\n> ab\n> ===";
    let mut s = EditorSession::open(original);
    let mut view = ReferenceView::new("\nab");
    s.select_with_affinity(s.revision(), range(0, 0), Affinity::Forward)
        .unwrap();
    let marked = s.compose(s.revision(), range(0, 0), "!").unwrap();
    assert_eq!(s.source_text(), original);
    assert_eq!(s.display_text(), "\nab");
    let replacement = DisplayReplacement {
        range: range(0, 4),
        inserted: "!\nAC".into(),
    };
    assert_eq!(
        s.replace_many(
            s.revision(),
            std::slice::from_ref(&replacement),
            &mut |_| Err("blocked".into())
        ),
        Err(EditorError::Persistence("blocked".into()))
    );
    assert_eq!(s.source_text(), original);
    assert_eq!(s.display_text(), "\nab");
    assert_eq!(s.revision(), Revision(0));
    assert_eq!(s.selection(), range(0, 0));
    assert_eq!(s.composition(), Some(&marked));
    let mut accepts = 0;
    view.apply(
        s.replace_many(s.revision(), &[replacement], &mut |_| {
            accepts += 1;
            Ok(())
        })
        .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(s.revision(), Revision(1));
    assert_eq!(s.source_text(), "> > !\nAC");
    assert_eq!(view.text, "!\nAC");
    assert_eq!(s.selection(), range(4, 4));
    assert!(s.composition().is_none());
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), committed_marking);
    assert_eq!(view.text, "!\n\nab");
    assert_eq!(s.selection(), range(1, 1));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), original);
    assert_eq!(view.text, "\nab");
    assert_eq!(s.selection(), range(0, 0));
    assert_eq!(s.affinity(), Affinity::Forward);
    assert!(s.undo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), committed_marking);
    assert_eq!(view.text, "!\n\nab");
    assert_eq!(s.selection(), range(1, 1));
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "> > !\nAC");
    assert_eq!(view.text, "!\nAC");
    assert_eq!(s.selection(), range(4, 4));
    assert!(s.redo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
}

#[test]
fn selected_body_retirement_keeps_one_line_and_carried_inline_formats_local() {
    for (raw, inserted, expected) in [
        ("> > !\n>\n> ab\n> ===", "AC", "> > AC"),
        ("> > `!`\n>\n> ab\n> ===", "!\nAC", "> > `!`\n`AC`"),
        ("> > __!__\n>\n> ab\n> ===", "!\nAC", "> > __!\nAC__"),
    ] {
        let tail = "\n\n__untouched__ &amp; tail\n";
        let original = format!("{raw}{tail}");
        let expected = format!("{expected}{tail}");
        let shown = format!("{inserted}\n\nuntouched & tail\n");
        assert_eq!(EditorSession::open(&expected).display_text(), shown);
        let mut s = EditorSession::open(&original);
        let mut view = ReferenceView::new("!\n\nab\n\nuntouched & tail\n");
        s.select_with_affinity(s.revision(), range(0, 5), Affinity::Forward)
            .unwrap();
        view.apply(
            s.replace_many(
                s.revision(),
                &[DisplayReplacement {
                    range: range(0, 5),
                    inserted: inserted.into(),
                }],
                &mut |_| Ok(()),
            )
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(inserted.len(), inserted.len()));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), original);
        assert_eq!(s.selection(), range(0, 5));
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
    }
}

#[test]
fn separator_only_selections_do_not_acquire_body_ownership_from_empty_lines() {
    for (raw, shown, selected) in [
        ("> > !\n>\n> ab\n> ===", "!\n\nab", range(1, 5)),
        ("> > !\n>\n>\n> ab\n> ===", "!\n\n\nab", range(2, 6)),
    ] {
        let mut s = EditorSession::open(raw);
        s.select(s.revision(), selected).unwrap();
        let mut accepts = 0;
        assert_eq!(
            s.replace_many(
                s.revision(),
                &[DisplayReplacement {
                    range: selected,
                    inserted: "AC".into(),
                }],
                &mut |_| {
                    accepts += 1;
                    Ok(())
                }
            ),
            Err(EditorError::UnrepresentableFormat)
        );
        assert_eq!(accepts, 0);
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.display_text(), shown);
        assert_eq!(s.revision(), Revision(0));
        assert_eq!(s.selection(), selected);
        assert!(s.undo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
    }
}

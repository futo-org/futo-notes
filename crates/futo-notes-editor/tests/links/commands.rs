use super::*;

#[test]
fn edit_link_inside_part_of_a_bold_span_keeps_the_unselected_formatting() {
    use futo_notes_editor::InlineFormat;
    let original = "Read **release notes** now";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("Read release notes now");
    session.select(Revision(0), range(5, 12)).unwrap();
    view.apply(
        session
            .edit_link(
                Revision(0),
                range(5, 12),
                "release",
                "https://example.test/releases",
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(view.text, "Read release notes now");
    let projection = session
        .project(Revision(1), range(0, view.text.len()))
        .unwrap();
    assert_eq!(projection.links.len(), 1);
    assert_eq!(projection.links[0].range, range(5, 12));
    assert_eq!(
        projection.links[0].destination,
        "https://example.test/releases"
    );
    for at in 5..18 {
        assert!(
            projection.runs.iter().any(|run| run.range.start.0 <= at
                && at < run.range.end.0
                && run.formats.contains(&InlineFormat::Bold)),
            "missing bold at {at}"
        );
    }
    let edited = session.source_text();
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(session.selection(), range(5, 12));
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), edited);
    assert_eq!(view.text, "Read release notes now");
}

#[test]
fn partial_link_selection_preserves_each_neighboring_inline_span() {
    for (original, display, label) in [
        (
            "Read **release notes** now",
            "Read release notes now",
            "notes",
        ),
        (
            "Read *release notes* now",
            "Read release notes now",
            "release",
        ),
        (
            "Read ~~release notes~~ now",
            "Read release notes now",
            "release",
        ),
        (
            "Read ***release notes*** now",
            "Read release notes now",
            "release",
        ),
        (
            "Read **release *notes later*** now",
            "Read release notes later now",
            "release notes",
        ),
        (
            "Read **release** *notes later* now",
            "Read release notes later now",
            "release notes",
        ),
        (
            "Read `release notes` now",
            "Read release notes now",
            "release",
        ),
        (
            "Read **`release notes`** now",
            "Read release notes now",
            "release",
        ),
    ] {
        let mut session = EditorSession::open(original);
        let start = display.find(label).unwrap();
        let target = range(start, start + label.len());
        session.select(Revision(0), target).unwrap();
        let formats = |session: &EditorSession| {
            let runs = session
                .project(session.revision(), range(0, display.len()))
                .unwrap()
                .runs;
            (0..display.len())
                .map(|at| {
                    runs.iter()
                        .find(|run| run.range.start.0 <= at && at < run.range.end.0)
                        .map(|run| run.formats.clone())
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
        };
        let before = formats(&session);
        let mut view = ReferenceView::new(display);
        view.apply(
            session
                .edit_link(
                    Revision(0),
                    target,
                    label,
                    "https://x.test",
                    &mut |_| Ok(()),
                )
                .unwrap_or_else(|e| panic!("{original:?}: {e:?}"))
                .unwrap(),
        );
        assert_eq!(view.text, display, "{original:?}");
        assert_eq!(formats(&session), before, "{original:?}");
        let link = session.inspect_link(Revision(1), target).unwrap().unwrap();
        assert_eq!(link.range, target, "{original:?}");
        assert_eq!(link.destination, "https://x.test");
        let edited = session.source_text();
        assert_eq!(EditorSession::open(&edited).display_text(), display);
        view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), original);
        assert_eq!(session.selection(), target);
        view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), edited);
        assert_eq!(formats(&session), before, "{original:?}");
    }
}

#[test]
fn inspection_reports_one_whole_link_across_nested_marks_and_keeps_same_href_runs_distinct() {
    let source = "[one __two__](https://x.test) gap [three](https://x.test)";
    let session = EditorSession::open(source);
    let first = session
        .inspect_link(Revision(0), range(5, 6))
        .unwrap()
        .unwrap();
    assert_eq!(first.range, range(0, 7));
    assert_eq!(first.destination, "https://x.test");
    let second = session
        .inspect_link(Revision(0), range(13, 14))
        .unwrap()
        .unwrap();
    assert_eq!(second.range, range(12, 17));
    assert!(session
        .inspect_link(Revision(0), range(9, 9))
        .unwrap()
        .is_none());
    let projection = session.project(Revision(0), range(0, 17)).unwrap();
    assert_eq!(projection.links, vec![first, second]);
    assert_eq!(session.source_text(), source);
}

#[test]
fn selected_link_commands_preserve_selection_nested_styles_and_byte_exact_undo() {
    let original = "read the __docs__ now";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("read the docs now");
    session.select(Revision(0), range(9, 13)).unwrap();
    view.apply(
        session
            .set_link(Revision(0), range(9, 13), "https://x.test", &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "read the [__docs__](<https://x.test>) now"
    );
    assert_eq!(view.text, "read the docs now");
    assert_eq!(session.selection(), range(9, 13));
    session.select(Revision(1), range(10, 11)).unwrap();
    view.apply(
        session
            .set_link(
                Revision(1),
                range(10, 11),
                "https://x.test/moved",
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "read the [__docs__](<https://x.test/moved>) now"
    );
    assert_eq!(session.selection(), range(10, 11));
    view.apply(
        session
            .set_link(Revision(2), range(10, 11), "", &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), original);
    assert_eq!(session.selection(), range(10, 11));
    for revision in 3..6 {
        view.apply(
            session
                .undo(Revision(revision), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
    }
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, "read the docs now");
    for revision in 6..9 {
        view.apply(
            session
                .redo(Revision(revision), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
    }
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, "read the docs now");
}

#[test]
fn updating_only_destination_preserves_title_quote_and_surrounding_marker_spelling() {
    let original = "__before [one](https://old.test 'A title') after__\r\n";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("before one after\r\n");
    session.select(Revision(0), range(8, 9)).unwrap();
    view.apply(
        session
            .set_link(Revision(0), range(8, 9), "https://x.test", &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "__before [one](https://x.test 'A title') after__\r\n"
    );
    assert_eq!(view.text, "before one after\r\n");
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
}

#[test]
fn link_insertion_at_a_caret_uses_its_destination_as_label_and_preserves_exact_undo() {
    let mut session = EditorSession::open("see ");
    let mut view = ReferenceView::new("see ");
    session.select(Revision(0), range(4, 4)).unwrap();
    view.apply(
        session
            .set_link(Revision(0), range(4, 4), "https://x.test", &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "see https://x.test");
    assert_eq!(view.text, "see https://x.test");
    assert_eq!(session.selection(), range(18, 18));
    assert_eq!(
        session.project(Revision(1), range(0, 18)).unwrap().links[0].destination,
        "https://x.test"
    );
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "see ");
    assert_eq!(view.text, "see ");
    assert_eq!(session.selection(), range(4, 4));
}

#[test]
fn adjacent_equal_destinations_form_one_command_run_without_rewriting_untouched_source() {
    let original = "[ab](https://x.test)[cd](https://x.test)";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("abcd");
    let link = session
        .inspect_link(Revision(0), range(0, 1))
        .unwrap()
        .unwrap();
    assert_eq!(link.range, range(0, 4));
    assert_eq!(session.source_text(), original);
    view.apply(
        session
            .set_link(
                Revision(0),
                range(0, 1),
                "https://new.test",
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "[abcd](<https://new.test>)");
    assert_eq!(view.text, "abcd");
    assert_eq!(session.selection(), range(0, 1));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
}

#[test]
fn edit_link_changes_label_and_target_in_one_accepted_undo_step() {
    let original = "__before [old](https://old.test 'Title') after__\r\n";
    let mut session = EditorSession::open(original);
    session.select(Revision(0), range(8, 9)).unwrap();
    let mut accepted = 0;
    let change = session
        .edit_link(
            Revision(0),
            range(8, 9),
            "新 [label]",
            "https://new.test",
            &mut |_| {
                accepted += 1;
                Ok(())
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(session.display_text(), "before 新 [label] after\r\n");
    assert_eq!(
        session
            .inspect_link(Revision(1), range(7, 10))
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("Title")
    );
    assert!(session.source_text().starts_with("__before ["));
    assert!(session.source_text().ends_with(" after__\r\n"));
    assert_eq!(change.selection, range(18, 18));
    session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), original);
    assert_eq!(session.selection(), range(8, 9));
    assert!(session
        .undo(Revision(2), &mut |_| Ok(()))
        .unwrap()
        .is_none());
}

#[test]
fn edit_link_inserts_literal_label_unlinks_and_rejects_stale_or_refused_edits() {
    let mut session = EditorSession::open("see  tail");
    session.select(Revision(0), range(4, 4)).unwrap();
    session
        .edit_link(Revision(0), range(4, 4), "a*[雪]|", "/x", &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.display_text(), "see a*[雪]| tail");
    assert_eq!(
        session
            .inspect_link(Revision(1), range(4, 5))
            .unwrap()
            .unwrap()
            .destination,
        "/x"
    );
    let linked = session.source_text();
    assert!(session
        .edit_link(Revision(1), range(4, 5), "a*[雪]|", "/x", &mut |_| panic!(
            "no-op accepted"
        ))
        .unwrap()
        .is_none());
    assert!(session
        .edit_link(Revision(0), range(4, 5), "bad", "/bad", &mut |_| panic!(
            "stale accepted"
        ))
        .is_err());
    assert!(session
        .edit_link(Revision(1), range(4, 5), "bad", "/bad", &mut |_| Err(
            "refused".into()
        ))
        .is_err());
    assert_eq!(session.source_text(), linked);
    session
        .edit_link(Revision(1), range(4, 5), "plain []", "", &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.display_text(), "see plain [] tail");
    assert!(session
        .inspect_link(Revision(2), range(4, 5))
        .unwrap()
        .is_none());
    session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), linked);
    session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), "see  tail");
}

#[test]
fn edit_link_settles_composition_and_refusal_preserves_the_overlay() {
    let mut session = EditorSession::open("old tail");
    session.compose(Revision(0), range(0, 3), "new").unwrap();
    assert!(session
        .edit_link(Revision(0), range(0, 3), "label", "/x", &mut |_| Err(
            "refused".into()
        ))
        .is_err());
    assert_eq!(session.source_text(), "old tail");
    assert!(session.composition().is_some());
    let mut accepted = 0;
    session
        .edit_link(Revision(0), range(0, 3), "label", "/x", &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(session.display_text(), "label tail");
    assert!(session.composition().is_none());
    session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.display_text(), "new tail");
    session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), "old tail");
}

#[test]
fn edit_link_in_a_table_cell_keeps_neighbor_source_and_literal_pipes() {
    let original = "| a | b |\n| --- | --- |\n| c | d |\n";
    let mut session = EditorSession::open(original);
    let table = session
        .inspect_table(Revision(0), range(0, 0))
        .unwrap()
        .unwrap();
    let target = table.rows[1][0].content;
    session
        .edit_link(Revision(0), target, "x|y", "/x", &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert!(session.source_text().contains(" | d |\n"));
    let table = session
        .inspect_table(Revision(1), range(0, 0))
        .unwrap()
        .unwrap();
    assert_eq!(table.columns, 2);
    let cell = table.rows[1][0].content;
    assert_eq!(session.project(Revision(1), cell).unwrap().text, "x|y");
    session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), original);
}

#[test]
fn empty_supplied_label_at_a_caret_does_not_insert_the_destination_or_add_history() {
    let mut session = EditorSession::open("see ");
    assert!(session
        .edit_link(Revision(0), range(4, 4), "", "/target", &mut |_| panic!(
            "empty label accepted"
        ))
        .unwrap()
        .is_none());
    assert_eq!(session.source_text(), "see ");
    assert_eq!(session.revision(), Revision(0));
    assert!(session
        .undo(Revision(0), &mut |_| Ok(()))
        .unwrap()
        .is_none());
}

#[test]
fn edit_link_label_with_punctuation_inside_a_code_formatted_label_is_literal() {
    let original = "[`old`](/old)";
    let mut session = EditorSession::open(original);
    session.select(Revision(0), range(0, 3)).unwrap();
    session
        .edit_link(Revision(0), range(0, 3), "a*b", "/old", &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.display_text(), "a*b");
    assert!(session.source_text().contains("a*b"));
    session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), original);
}

#[test]
fn edit_link_clearing_the_sole_link_leaves_an_empty_document_with_exact_undo() {
    let original = "[old](/old)";
    let mut session = EditorSession::open(original);
    session.select(Revision(0), range(0, 3)).unwrap();
    let mut accepted = 0;
    session
        .edit_link(Revision(0), range(0, 3), "", "", &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(session.source_text(), "");
    session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), original);
}

#[test]
fn a_link_on_bold_text_keeps_both_semantics() {
    for destination in ["google.com", "https://google.com"] {
        let mut s = EditorSession::open("**This editor.** Is beautiful.");
        s.select(s.revision(), range(0, 4)).unwrap();
        s.edit_link(s.revision(), range(0, 4), "This", destination, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap();
        assert!(
            s.inspect_link(s.revision(), range(0, 4)).unwrap().is_some(),
            "{}",
            s.source_text()
        );
        assert_eq!(s.display_text(), "This editor. Is beautiful.");
        assert!(s
            .toolbar_state()
            .formats
            .contains(&futo_notes_editor::InlineFormat::Bold));
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), "**This editor.** Is beautiful.");
        s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert!(s.inspect_link(s.revision(), range(0, 4)).unwrap().is_some());
    }
}

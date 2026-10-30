use super::*;

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

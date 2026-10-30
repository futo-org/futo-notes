use futo_notes_editor::{DisplayOffset, DisplayRange, EditorSession, Revision};
mod common;
use common::ReferenceView;

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[test]
fn correcting_nested_link_label_preserves_destination_spelling_and_exact_history() {
    let original = "see [teh __docs__](<https://x.test/a> \"Title\")\t\r\n";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("see teh docs\t\r\n");
    assert_eq!(session.display_text(), view.text);
    view.apply(
        session
            .replace(Revision(0), range(4, 7), "the", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "see the docs\t\r\n");
    assert_eq!(
        session.source_text(),
        "see [the __docs__](<https://x.test/a> \"Title\")\t\r\n"
    );
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, "see teh docs\t\r\n");
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(
        session.source_text(),
        "see [the __docs__](<https://x.test/a> \"Title\")\t\r\n"
    );
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
fn loaded_gfm_urls_report_canonical_destinations_and_leave_code_opaque() {
    let source = "go to www.example.com. or https://a.com/x_y, not https:// `https://code.test`\n\n```\nhttps://fence.test\n```";
    let session = EditorSession::open(source);
    let display = "go to www.example.com. or https://a.com/x_y, not https:// https://code.test\n\nhttps://fence.test";
    assert_eq!(session.display_text(), display);
    let links = session
        .project(Revision(0), range(0, display.len()))
        .unwrap()
        .links;
    assert_eq!(links.len(), 2);
    assert_eq!(links[0].range, range(6, 21));
    assert_eq!(links[0].destination, "http://www.example.com");
    assert_eq!(links[1].range, range(26, 43));
    assert_eq!(links[1].destination, "https://a.com/x_y");
    assert_eq!(session.source_text(), source);
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
fn typing_a_bare_url_waits_for_word_end_and_keeps_bare_source_through_history() {
    let mut session = EditorSession::open("");
    let mut view = ReferenceView::new("");
    view.apply(
        session
            .replace(
                Revision(0),
                range(0, 0),
                "see https://youtube.com",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(view.text, "see https://youtube.com");
    assert_eq!(session.source_text(), "see https://youtube.com");
    assert!(session
        .project(Revision(1), range(0, 23))
        .unwrap()
        .links
        .is_empty());
    view.apply(
        session
            .replace(Revision(1), range(23, 23), " ok", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "see https://youtube.com ok");
    assert_eq!(session.source_text(), "see https://youtube.com ok");
    let links = session.project(Revision(2), range(0, 26)).unwrap().links;
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].range, range(4, 23));
    assert_eq!(links[0].destination, "https://youtube.com");
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "see https://youtube.com");
    assert_eq!(view.text, "see https://youtube.com");
    assert!(session
        .project(Revision(3), range(0, 23))
        .unwrap()
        .links
        .is_empty());
    view.apply(session.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "see https://youtube.com ok");
    assert_eq!(
        session
            .project(Revision(4), range(0, 26))
            .unwrap()
            .links
            .len(),
        1
    );
}

#[test]
fn hand_typed_link_syntax_keeps_literal_outer_text_around_only_the_bare_url() {
    let mut session = EditorSession::open("");
    let mut view = ReferenceView::new("");
    for ch in "[t](https://x.test)".chars() {
        let at = view.text.len();
        view.apply(
            session
                .replace(
                    session.revision(),
                    range(at, at),
                    &ch.to_string(),
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        assert!(session
            .project(session.revision(), range(0, view.text.len()))
            .unwrap()
            .links
            .is_empty());
    }
    assert_eq!(view.text, "[t](https://x.test)");
    let at = view.text.len();
    view.apply(
        session
            .replace(session.revision(), range(at, at), " ok", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "[t](https://x.test) ok");
    assert_eq!(session.source_text(), "\\[t](https://x.test) ok");
    let reopened = EditorSession::open(&session.source_text());
    assert_eq!(
        reopened
            .project(Revision(0), range(0, view.text.len()))
            .unwrap()
            .links
            .len(),
        1,
        "fresh-open literal bracket source must retain its inner URL"
    );
    let links = session
        .project(session.revision(), range(0, view.text.len()))
        .unwrap()
        .links;
    assert_eq!(
        links.len(),
        1,
        "active word-end semantics must match fresh open"
    );
    assert_eq!(links[0].range, range(4, 18));
    assert_eq!(links[0].destination, "https://x.test");
    assert_eq!(
        EditorSession::open(&session.source_text()).display_text(),
        view.text
    );
}

#[test]
fn hand_typed_angle_link_saves_literal_brackets_around_the_inner_autolink() {
    let mut session = EditorSession::open("");
    let mut view = ReferenceView::new("");
    for ch in "<https://x.test>".chars() {
        let at = view.text.len();
        view.apply(
            session
                .replace(
                    session.revision(),
                    range(at, at),
                    &ch.to_string(),
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        assert!(session
            .project(session.revision(), range(0, view.text.len()))
            .unwrap()
            .links
            .is_empty());
    }
    let at = view.text.len();
    view.apply(
        session
            .replace(session.revision(), range(at, at), " ok", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test> ok");
    assert_eq!(session.source_text(), "<<https://x.test>> ok");
    let links = session
        .project(session.revision(), range(0, view.text.len()))
        .unwrap()
        .links;
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].range, range(1, 15));
    assert_eq!(links[0].destination, "https://x.test");
    assert_eq!(
        EditorSession::open(&session.source_text()).display_text(),
        view.text
    );
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
fn link_label_boundaries_come_from_parser_children_including_opaque_code_brackets() {
    let original = "[a `]` b](https://x.test)\r\n";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("a ] b\r\n");
    assert_eq!(session.display_text(), view.text);
    view.apply(
        session
            .replace(Revision(0), range(4, 5), "B", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "a ] B\r\n");
    assert_eq!(session.source_text(), "[a `]` B](https://x.test)\r\n");
    assert_eq!(
        session
            .inspect_link(Revision(1), range(4, 5))
            .unwrap()
            .unwrap()
            .destination,
        "https://x.test"
    );
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
}

#[test]
fn unfinished_urls_elsewhere_do_not_add_metadata_work_to_a_local_keystroke() {
    let mut work = Vec::new();
    for count in [20, 200] {
        let mut session = EditorSession::open(&"x\n\n".repeat(count));
        for index in (0..count).rev() {
            session
                .replace(
                    session.revision(),
                    range(index * 3, index * 3 + 1),
                    "https://x.test",
                    &mut |_| Ok(()),
                )
                .unwrap();
        }
        let change = session
            .replace(session.revision(), range(8, 8), "x", &mut |_| Ok(()))
            .unwrap();
        assert!(session.source_text().starts_with("https://xx.test\n\n"));
        assert!(session
            .project(session.revision(), range(0, 14))
            .unwrap()
            .links
            .is_empty());
        assert!(
            change.work.link_metadata_items > 0,
            "metadata accounting must observe the edited unfinished URL"
        );
        work.push(change.work.link_metadata_items);
    }
    assert_eq!(
        work[0], work[1],
        "distant unfinished URL metadata must stay in its own rows"
    );
}

#[test]
fn editing_a_loaded_bare_url_label_retains_its_destination_with_explicit_spelling() {
    let mut session = EditorSession::open("https://x.test");
    let mut view = ReferenceView::new("https://x.test");
    view.apply(
        session
            .replace(Revision(0), range(14, 14), "/new", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "https://x.test/new");
    assert_eq!(
        session.source_text(),
        "[https://x.test/new](<https://x.test>)"
    );
    assert_eq!(
        session
            .inspect_link(Revision(1), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        "https://x.test"
    );
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "https://x.test");
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(view.text, "https://x.test/new");
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
fn correction_and_reconversion_inside_a_nested_label_preserve_destination_and_exact_history() {
    let original = "see [teh __docs__](https://x.test 'T') tail\r\n";
    let corrected = "see [the __docs__](https://x.test 'T') tail\r\n";
    let reconverted = "see [the __資料__](https://x.test 'T') tail\r\n";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("see teh docs tail\r\n");
    view.apply(
        session
            .replace_os(
                Revision(0),
                range(0, 19),
                "see the docs tail\r\n",
                &[],
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), corrected);
    assert_eq!(view.text, "see the docs tail\r\n");
    session
        .compose(Revision(1), range(8, 12), "ドックス")
        .unwrap();
    assert_eq!(session.source_text(), corrected);
    view.apply(
        session
            .commit_composition(Revision(1), Some("資料"), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), reconverted);
    assert_eq!(view.text, "see the 資料 tail\r\n");
    assert_eq!(
        session
            .inspect_link(Revision(2), range(8, 11))
            .unwrap()
            .unwrap()
            .destination,
        "https://x.test"
    );
    assert!(session
        .commit_composition(Revision(2), None, &mut |_| panic!(
            "repeated commit appended"
        ))
        .unwrap()
        .is_none());
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), corrected);
    view.apply(session.undo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(session.redo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), reconverted);
}

#[test]
fn canonical_destinations_remain_data_and_unrelated_edits_keep_all_untouched_spelling() {
    let original = "[web](https://x.test/a?b=1&amp;c=2 \"T\") [mail](mailto:a@x.test) [phone](tel:+123) [unsafe](javascript:alert(1)) `https://code.test` tail";
    let mut session = EditorSession::open(original);
    let display = "web mail phone unsafe https://code.test tail";
    let mut view = ReferenceView::new(display);
    let links = session
        .project(Revision(0), range(0, display.len()))
        .unwrap()
        .links;
    assert_eq!(
        links
            .iter()
            .map(|link| link.destination.as_str())
            .collect::<Vec<_>>(),
        vec![
            "https://x.test/a?b=1&c=2",
            "mailto:a@x.test",
            "tel:+123",
            "javascript:alert(1)"
        ]
    );
    // Activation remains scheme-guarded by the existing platform owner; the
    // engine never destroys an unsupported destination stored in Markdown.
    view.apply(
        session
            .replace(
                Revision(0),
                range(display.len(), display.len()),
                "!",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(session.source_text(), format!("{original}!"));
    assert_eq!(view.text, format!("{display}!"));
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
}

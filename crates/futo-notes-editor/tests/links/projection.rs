use super::*;

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
            "https://x.test/a?b=1&amp;c=2",
            "mailto:a@x.test",
            "tel:+123",
            "javascript:alert(1)"
        ]
    );
    // An entity is literal text, in a destination too.
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

#[test]
fn typing_at_the_end_of_a_loaded_bare_url_extends_its_address_as_typed() {
    let mut session = EditorSession::open("https://x.test");
    let mut view = ReferenceView::new("https://x.test");
    view.apply(
        session
            .replace(Revision(0), range(14, 14), "/new", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "https://x.test/new");
    assert_eq!(session.source_text(), "https://x.test/new");
    assert_eq!(
        session
            .inspect_link(Revision(1), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        "https://x.test/new"
    );
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "https://x.test");
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(view.text, "https://x.test/new");
}

#[test]
fn canonical_inner_autolink_loads_literal_outer_pair_with_clean_url() {
    let source = "<<https://x.test>>";
    let session = EditorSession::open(source);
    assert_eq!(session.source_text(), source);
    assert_eq!(session.display_text(), "<https://x.test>");
    let links = session.project(Revision(0), range(0, 16)).unwrap().links;
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].range, range(1, 15));
    assert_eq!(links[0].destination, "https://x.test");
}

#[test]
fn bracket_adjacent_gfm_link_keeps_its_own_extent_after_identical_code_text() {
    let source = "`https://x.test` [https://x.test";
    let session = EditorSession::open(source);
    assert_eq!(session.source_text(), source);
    assert_eq!(session.display_text(), "https://x.test [https://x.test");
    let links = session.project(Revision(0), range(0, 30)).unwrap().links;
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].range, range(16, 30));
    assert_eq!(links[0].destination, "https://x.test");
    assert!(session
        .inspect_link(Revision(0), range(1, 2))
        .unwrap()
        .is_none());
}

#[test]
fn escaped_address_text_with_partial_code_reads_no_link() {
    use futo_notes_editor::InlineFormat;
    // Escaped address punctuation reads as text, not as a web address.
    for source in [
        "\\<https\\://x.test`/path`>",
        "\\<https\\:\\/\\/x\\.test`/path`>",
    ] {
        let session = EditorSession::open(source);
        assert_eq!(session.source_text(), source);
        assert_eq!(session.display_text(), "<https://x.test/path>");
        let query = session.project(Revision(0), range(0, 21)).unwrap();
        assert!(
            query.links.is_empty(),
            "source={source:?}; links={:?}",
            query.links
        );
        let code: Vec<_> = query
            .runs
            .iter()
            .filter(|run| run.formats.contains(&InlineFormat::Code))
            .map(|run| run.range)
            .collect();
        assert_eq!(code, vec![range(15, 20)]);
    }
}

/// The markdown crate's tree builder panicked on these notes, and release
/// builds abort on panic (#283). Opening and typing must match a fresh open.
#[test]
fn notes_that_crashed_the_old_markdown_scans_open_and_take_input() {
    let same = |session: &EditorSession| {
        let fresh = EditorSession::open(&session.source_text());
        let whole = |session: &EditorSession| {
            let slice = session
                .project(session.revision(), range(0, session.display_text().len()))
                .unwrap();
            (slice.text, slice.runs, slice.blocks, slice.links)
        };
        assert_eq!(whole(session), whole(&fresh));
    };
    // An item fence past its content column before a shallower ordered line.
    let fence = "-  ```\n  1. x\n[a]: b\n";
    let mut session = EditorSession::open(fence);
    assert_eq!(session.source_text(), fence);
    same(&session);
    session
        .replace(Revision(0), range(0, 0), "x", &mut |_| Ok(()))
        .unwrap();
    same(&session);
    // A list item typed at the end of a line after a `-`/`--` pair.
    let dashes = "title: front\n-\n--\nescaped \\* star and 3 * 4 56\n";
    let mut session = EditorSession::open(dashes);
    same(&session);
    let end = session.display_text().trim_end().len();
    session
        .replace(Revision(0), range(end, end), "\n- ", &mut |_| Ok(()))
        .unwrap();
    assert!(session.source_text().ends_with("56\n- \n"));
    assert!(session.display_text().ends_with("56\n\n"));
    same(&session);
}

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
    let display = "go to www.example.com. or https://a.com/x_y, not https:// https://code.test\n\nhttps://fence.test\n";
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

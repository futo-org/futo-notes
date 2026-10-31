//! User edits retire the Code guard without inventing loaded source ownership.
use super::*;
use futo_notes_editor::{InlineFormat, InputAction};

#[test]
fn deleting_the_last_code_content_releases_only_the_live_word_end_guard() {
    let mut session = EditorSession::open("");
    let mut view = ReferenceView::new("");
    view.apply(
        session
            .replace(
                Revision(0),
                range(0, 0),
                "<https://x.test/path",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    view.apply(
        session
            .replace(Revision(1), range(20, 20), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    session.select(Revision(2), range(15, 20)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let guarded = session.source_text();
    view.apply(
        session
            .replace_action(
                Revision(3),
                range(15, 20),
                "",
                InputAction::Isolated,
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test>");
    let deleted = session.source_text();
    let query = session.project(Revision(4), range(0, 16)).unwrap();
    assert!(query.links.is_empty());
    assert!(query
        .runs
        .iter()
        .all(|run| !run.formats.contains(&InlineFormat::Code)));
    let mut loaded = EditorSession::open(&deleted);
    loaded
        .replace(Revision(0), range(16, 16), " ", &mut |_| Ok(()))
        .unwrap();
    assert!(loaded
        .project(Revision(1), range(0, 17))
        .unwrap()
        .links
        .is_empty());
    session.select(Revision(4), range(16, 16)).unwrap();
    view.apply(
        session
            .replace(Revision(4), range(16, 16), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test> ");
    let link = session
        .inspect_link(Revision(5), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(link.destination, "https://x.test");
    assert_eq!(link.range, range(1, 15));
    view.apply(session.undo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), deleted);
    view.apply(session.undo(Revision(6), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), guarded);
    assert_eq!(view.text, "<https://x.test/path>");
    view.apply(session.redo(Revision(7), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), deleted);
    session.select(Revision(8), range(16, 16)).unwrap();
    view.apply(
        session
            .replace(Revision(8), range(16, 16), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(
        session
            .inspect_link(Revision(9), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        "https://x.test"
    );
}

#[test]
fn partial_code_keeps_a_www_prefix_literal_in_standard_source_and_reopen() {
    let candidate = EditorSession::open("\\<www\\.x.test`/path`>");
    assert_eq!(candidate.display_text(), "<www.x.test/path>");
    let loaded = candidate.project(Revision(0), range(0, 17)).unwrap();
    assert!(loaded.links.is_empty());
    assert!(loaded
        .runs
        .iter()
        .any(|run| run.range == range(11, 16) && run.formats.contains(&InlineFormat::Code)));
    let mut session = EditorSession::open("");
    let mut view = ReferenceView::new("");
    view.apply(
        session
            .replace(
                Revision(0),
                range(0, 0),
                "<www.x.test/path",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    view.apply(
        session
            .replace(Revision(1), range(16, 16), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<www.x.test/path>");
    assert!(session
        .project(Revision(2), range(0, 17))
        .unwrap()
        .links
        .is_empty());
    session.select(Revision(2), range(11, 16)).unwrap();
    let mut accepts = 0;
    view.apply(
        session
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(view.text, "<www.x.test/path>");
    let source = session.source_text();
    let fresh = EditorSession::open(&source);
    assert_eq!(fresh.display_text(), view.text);
    let query = fresh.project(Revision(0), range(0, 17)).unwrap();
    assert!(query.links.is_empty(), "actual standard source={source:?}");
    assert!(query
        .runs
        .iter()
        .any(|run| run.range == range(11, 16) && run.formats.contains(&InlineFormat::Code)));
    session.select(Revision(3), range(17, 17)).unwrap();
    view.apply(
        session
            .replace(Revision(3), range(17, 17), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert!(session
        .project(Revision(4), range(0, 18))
        .unwrap()
        .links
        .is_empty());
    view.apply(session.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), source);
    view.apply(session.undo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(view.text, "<www.x.test/path>");
    assert!(session
        .inspect_link(Revision(6), range(1, 2))
        .unwrap()
        .is_none());
}

#[test]
fn www_code_removal_waits_for_word_end_and_uses_the_canonical_http_target() {
    let literal = EditorSession::open("\\<www\\.x.test/path>");
    assert_eq!(literal.display_text(), "<www.x.test/path>");
    assert!(literal
        .project(Revision(0), range(0, 17))
        .unwrap()
        .links
        .is_empty());
    let active = EditorSession::open("<[www.x.test/path](<http://www.x.test/path>)> ");
    assert_eq!(active.display_text(), "<www.x.test/path> ");
    assert_eq!(
        active
            .inspect_link(Revision(0), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        "http://www.x.test/path"
    );
    let mut session = EditorSession::open("");
    let mut view = ReferenceView::new("");
    view.apply(
        session
            .replace(
                Revision(0),
                range(0, 0),
                "<www.x.test/path",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    view.apply(
        session
            .replace(Revision(1), range(16, 16), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    session.select(Revision(2), range(11, 16)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let guarded = session.source_text();
    view.apply(
        session
            .toggle_format(Revision(3), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let released = session.source_text();
    assert_eq!(view.text, "<www.x.test/path>");
    assert!(
        session
            .project(Revision(4), range(0, 17))
            .unwrap()
            .links
            .is_empty(),
        "guarded={guarded:?}; released={released:?}"
    );
    let fresh = EditorSession::open(&released);
    assert_eq!(fresh.display_text(), view.text);
    assert!(fresh
        .project(Revision(0), range(0, 17))
        .unwrap()
        .links
        .is_empty());
    session.select(Revision(4), range(17, 17)).unwrap();
    view.apply(
        session
            .replace(Revision(4), range(17, 17), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<www.x.test/path> ");
    let link = session.inspect_link(Revision(5), range(1, 2)).unwrap();
    assert_eq!(
        link.as_ref().map(|link| link.destination.as_str()),
        Some("http://www.x.test/path"),
        "guarded={guarded:?}; released={released:?}; source={:?}",
        session.source_text()
    );
    assert_eq!(link.unwrap().range, range(1, 16));
    view.apply(session.undo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), released);
    view.apply(session.undo(Revision(6), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), guarded);
    assert!(session
        .project(Revision(7), range(0, 17))
        .unwrap()
        .links
        .is_empty());
}

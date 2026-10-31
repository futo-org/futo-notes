use super::*;
use futo_notes_editor::InlineFormat;

#[test]
fn partial_code_keeps_an_unselected_uri_prefix_literal_through_word_end_and_reopen() {
    // Canonical raw-token parsing supports this standard local spelling.
    // Shipping remark's decoded-text transform adds a prefix link; that
    // separately recorded discrepancy is not a portable source intent.
    let candidate = EditorSession::open("\\<https\\://x.test`/path`>");
    assert_eq!(candidate.display_text(), "<https://x.test/path>");
    assert!(candidate
        .project(Revision(0), range(0, 21))
        .unwrap()
        .links
        .is_empty());
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
    assert_eq!(session.source_text(), "<<https://x.test/path>>");
    session.select(Revision(2), range(15, 20)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test/path>");
    let query = session.project(session.revision(), range(0, 21)).unwrap();
    assert!(query.links.is_empty());
    let code: Vec<_> = query
        .runs
        .iter()
        .filter(|run| run.formats.contains(&InlineFormat::Code))
        .map(|run| run.range)
        .collect();
    assert_eq!(code, vec![range(15, 20)]);
    let source = session.source_text();
    let reopened = EditorSession::open(&source);
    assert_eq!(reopened.display_text(), view.text);
    assert!(
        reopened
            .project(Revision(0), range(0, 21))
            .unwrap()
            .links
            .is_empty(),
        "the unselected URI prefix stays literal; source={source:?}"
    );
    session.select(session.revision(), range(21, 21)).unwrap();
    view.apply(
        session
            .replace(session.revision(), range(21, 21), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test/path> ");
    assert!(
        session.source_text().contains("\\:"),
        "word-end must retain the owned literal scalar while Code remains"
    );
    let loaded_after_word = EditorSession::open(&session.source_text());
    assert!(loaded_after_word
        .project(Revision(0), range(0, 22))
        .unwrap()
        .links
        .is_empty());
    assert!(session
        .project(session.revision(), range(0, 22))
        .unwrap()
        .links
        .is_empty());
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), source);
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "<<https://x.test/path>>");
    assert!(session
        .inspect_link(session.revision(), range(1, 2))
        .unwrap()
        .is_none());
    view.apply(
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), source);
    assert!(session
        .project(session.revision(), range(0, 21))
        .unwrap()
        .links
        .is_empty());
}

#[test]
fn live_code_removal_releases_its_literal_url_guard_but_loaded_escape_keeps_authored_intent() {
    let authored = "\\<https\\://x.test`/path`>";
    let mut loaded = EditorSession::open(authored);
    loaded.select(Revision(0), range(15, 20)).unwrap();
    loaded
        .toggle_format(Revision(0), InlineFormat::Code, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    loaded.select(loaded.revision(), range(21, 21)).unwrap();
    loaded
        .replace(loaded.revision(), range(21, 21), " ", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(loaded.display_text(), "<https://x.test/path> ");
    assert!(loaded.source_text().contains("\\:"));
    assert!(loaded
        .project(loaded.revision(), range(0, 22))
        .unwrap()
        .links
        .is_empty());

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
            .toggle_format(Revision(3), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let released = session.source_text();
    assert_eq!(view.text, "<https://x.test/path>");
    assert!(session
        .project(Revision(4), range(0, 21))
        .unwrap()
        .links
        .is_empty());
    session.select(Revision(4), range(21, 21)).unwrap();
    view.apply(
        session
            .replace(Revision(4), range(21, 21), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test/path> ");
    let link = session.inspect_link(Revision(5), range(1, 2)).unwrap();
    assert_eq!(
        link.as_ref().map(|link| link.destination.as_str()),
        Some("https://x.test/path")
    );
    assert_eq!(link.unwrap().range, range(1, 20));
    let reopened = EditorSession::open(&session.source_text());
    assert_eq!(reopened.display_text(), view.text);
    assert_eq!(
        reopened
            .inspect_link(Revision(0), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        "https://x.test/path"
    );
    view.apply(session.undo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), released);
    assert!(session
        .project(Revision(6), range(0, 21))
        .unwrap()
        .links
        .is_empty());
    view.apply(session.undo(Revision(6), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), guarded);
    let code = session.project(Revision(7), range(0, 21)).unwrap();
    assert!(code.links.is_empty());
    assert!(code
        .runs
        .iter()
        .any(|run| run.range == range(15, 20) && run.formats.contains(&InlineFormat::Code)));
}

use super::*;
use futo_notes_editor::{InlineFormat, SourceEdit, SourceOffset, SourceRange};

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
fn loaded_authored_colon_does_not_gain_typed_ownership_from_code_removal_or_word_end() {
    let record = |session: &EditorSession, stage| {
        let source = session.source_text();
        let display = session.display_text();
        let current = session
            .project(session.revision(), range(0, display.len()))
            .unwrap()
            .links;
        let reopened = EditorSession::open(&source);
        let fresh = reopened
            .project(Revision(0), range(0, display.len()))
            .unwrap()
            .links;
        (stage, source, display, current, fresh)
    };
    let mut records = Vec::new();
    let mut loaded = EditorSession::open("\\<https\\://x.test`/path`>");
    records.push(record(&loaded, "loaded Code"));
    loaded.select(Revision(0), range(15, 20)).unwrap();
    loaded
        .toggle_format(Revision(0), InlineFormat::Code, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    records.push(record(&loaded, "Code off"));
    loaded.select(loaded.revision(), range(21, 21)).unwrap();
    loaded
        .replace(loaded.revision(), range(21, 21), " ", &mut |_| Ok(()))
        .unwrap();
    records.push(record(&loaded, "Space after Code off"));
    let mut plain = EditorSession::open("\\<https\\://x.test/path>");
    records.push(record(&plain, "loaded plain"));
    plain
        .replace(Revision(0), range(21, 21), " ", &mut |_| Ok(()))
        .unwrap();
    records.push(record(&plain, "Space after loaded plain"));
    assert!(
        records
            .iter()
            .all(|(_, _, _, current, fresh)| current.is_empty() && fresh.is_empty()),
        "public canonical stage discriminator: {records:#?}"
    );
}

#[test]
fn live_code_removal_releases_its_literal_url_guard_at_word_end() {
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
        Some("https://x.test/path"),
        "live guarded={guarded:?}; released={released:?}; word-end source={:?}",
        session.source_text()
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

#[test]
fn an_identical_foreign_authored_uri_never_shares_the_live_code_colon_witness() {
    let prefix = "\\<https\\://x.test/path> / ";
    let mut session = EditorSession::open(prefix);
    let mut view = ReferenceView::new("<https://x.test/path> / ");
    assert_eq!(view.text.len(), 24);
    view.apply(
        session
            .replace(
                Revision(0),
                range(24, 24),
                "<https://x.test/path",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    view.apply(
        session
            .replace(Revision(1), range(44, 44), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    session.select(Revision(2), range(39, 44)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    view.apply(
        session
            .toggle_format(Revision(3), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    session.select(Revision(4), range(45, 45)).unwrap();
    view.apply(
        session
            .replace(Revision(4), range(45, 45), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test/path> / <https://x.test/path> ");
    let links = session.project(Revision(5), range(0, 46)).unwrap().links;
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].range, range(25, 44));
    assert_eq!(links[0].destination, "https://x.test/path");
    assert!(session.source_text().starts_with(prefix));
    let before = session.source_text();
    session.select(Revision(5), range(21, 21)).unwrap();
    view.apply(
        session
            .replace(Revision(5), range(21, 21), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test/path>  / <https://x.test/path> ");
    let links = session.project(Revision(6), range(0, 47)).unwrap().links;
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].range, range(26, 45));
    assert_eq!(links[0].destination, "https://x.test/path");
    let reopened = EditorSession::open(&session.source_text());
    assert_eq!(reopened.display_text(), view.text);
    assert_eq!(
        reopened.project(Revision(0), range(0, 47)).unwrap().links,
        links
    );
    view.apply(session.undo(Revision(6), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), before);
    assert_eq!(
        session.project(Revision(7), range(0, 46)).unwrap().links[0].range,
        range(25, 44)
    );
}

#[test]
fn transformed_and_restored_source_atom_does_not_recover_old_live_colon_identity() {
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
    let guarded = "<https\\://x.test`/path`>";
    assert_eq!(session.source_text(), guarded);
    // These public accepted source records overwrite the complete atom. Equal
    // final bytes cannot restore the retired original source-field identity.
    for (previous, end, removed, inserted) in [(3, 8, "\\:", "&#58;"), (4, 11, "&#58;", "\\:")] {
        view.apply(
            session
                .replay(&SourceEdit {
                    previous_revision: Revision(previous),
                    revision: Revision(previous + 1),
                    range: SourceRange {
                        start: SourceOffset(6),
                        end: SourceOffset(end),
                    },
                    removed: removed.into(),
                    inserted: inserted.into(),
                })
                .unwrap(),
        );
        assert_eq!(view.text, "<https://x.test/path>");
        let current = session.project(session.revision(), range(0, 21)).unwrap();
        assert!(current.links.is_empty());
        assert!(current
            .runs
            .iter()
            .any(|run| run.range == range(15, 20) && run.formats.contains(&InlineFormat::Code)));
    }
    assert_eq!(session.source_text(), guarded);
    session.select(Revision(5), range(15, 20)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(5), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    session.select(Revision(6), range(21, 21)).unwrap();
    view.apply(
        session
            .replace(Revision(6), range(21, 21), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test/path> ");
    assert!(session
        .project(Revision(7), range(0, 22))
        .unwrap()
        .links
        .is_empty());
    let reopened = EditorSession::open(&session.source_text());
    assert_eq!(reopened.display_text(), view.text);
    assert!(reopened
        .project(Revision(0), range(0, 22))
        .unwrap()
        .links
        .is_empty());
}

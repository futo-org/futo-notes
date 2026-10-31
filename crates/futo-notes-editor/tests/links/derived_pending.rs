use super::*;

#[test]
fn a_derived_heading_split_before_an_unfinished_url_retains_pending_meaning_through_history() {
    use futo_notes_editor::ParagraphKey;
    let mut session = EditorSession::open("# (");
    let mut view = ReferenceView::new("(");
    for ch in "https://x.test/a".chars() {
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
    }
    let original = "# (https://x.test/a";
    let entered = "# (\nhttps://x.test/a";
    assert_eq!(session.source_text(), original);
    assert!(session
        .inspect_link(session.revision(), range(2, 3))
        .unwrap()
        .is_none());
    session.select(session.revision(), range(1, 1)).unwrap();
    let mut accepted = 0;
    view.apply(
        session
            .paragraph_key(
                session.revision(),
                range(1, 1),
                ParagraphKey::Enter,
                &mut |_| {
                    accepted += 1;
                    Ok(())
                },
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(session.source_text(), entered);
    assert_eq!(view.text, "(\nhttps://x.test/a");
    assert_eq!(session.selection(), range(2, 2));
    assert!(session
        .inspect_link(session.revision(), range(2, 3))
        .unwrap()
        .is_none());
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), original);
    assert!(session
        .inspect_link(session.revision(), range(2, 3))
        .unwrap()
        .is_none());
    view.apply(
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), entered);
    assert!(session
        .inspect_link(session.revision(), range(2, 3))
        .unwrap()
        .is_none());
    // Saved standard source has no durable live-typing provenance on reopen.
    let reopened = EditorSession::open(entered);
    assert_eq!(
        reopened
            .inspect_link(reopened.revision(), range(2, 3))
            .unwrap()
            .unwrap()
            .destination,
        "https://x.test/a"
    );
    let end = view.text.len();
    view.apply(
        session
            .replace(session.revision(), range(end, end), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), "# (\nhttps://x.test/a ");
    assert_eq!(
        session
            .inspect_link(session.revision(), range(2, 3))
            .unwrap()
            .unwrap()
            .destination,
        "https://x.test/a"
    );
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), entered);
    assert!(session
        .inspect_link(session.revision(), range(2, 3))
        .unwrap()
        .is_none());
}

#[test]
fn heading_word_end_split_tracks_its_inserted_separator_after_live_delimiter_conversion() {
    use futo_notes_editor::{InlineFormat, ParagraphKey};
    // Canonical source/parser probes: referenceBlockShippingOracle.test.ts.
    // One public logical Typing input; this is not a native keyboard claim.
    let mut session = EditorSession::open("# x&#32;");
    let mut view = ReferenceView::new("x ");
    view.apply(
        session
            .replace(
                Revision(0),
                range(2, 2),
                "*b https://x.test/a*",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    let pending = "# x&#32;\\*b https://x.test/a*";
    let committed = "# x&#32;*b https://x.test/a*\n";
    assert_eq!(session.source_text(), pending);
    assert_eq!(view.text, "x *b https://x.test/a*");
    assert!(session
        .inspect_link(Revision(1), range(5, 6))
        .unwrap()
        .is_none());
    session.select(Revision(1), range(22, 22)).unwrap();
    let mut accepted = 0;
    view.apply(
        session
            .paragraph_key(Revision(1), range(22, 22), ParagraphKey::Enter, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(session.source_text(), committed);
    assert_eq!(view.text, "x b https://x.test/a\n");
    assert_eq!(session.selection(), range(21, 21));
    let link = session
        .inspect_link(Revision(2), range(4, 5))
        .unwrap()
        .unwrap();
    assert_eq!(link.destination, "https://x.test/a");
    assert_eq!(link.range, range(4, 20));
    assert!(link.title.is_none());
    assert!(session
        .project(Revision(2), range(2, 3))
        .unwrap()
        .runs
        .iter()
        .any(|run| run.formats.contains(&InlineFormat::Italic)));
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), pending);
    assert_eq!(view.text, "x *b https://x.test/a*");
    assert_eq!(session.selection(), range(22, 22));
    assert!(session
        .inspect_link(Revision(3), range(5, 6))
        .unwrap()
        .is_none());
    view.apply(session.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), committed);
    assert_eq!(session.selection(), range(21, 21));
    view.apply(
        session
            .replace(Revision(4), session.selection(), "!", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), "# x&#32;*b https://x.test/a*\n!");
    assert_eq!(view.text, "x b https://x.test/a\n!");
}

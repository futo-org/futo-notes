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

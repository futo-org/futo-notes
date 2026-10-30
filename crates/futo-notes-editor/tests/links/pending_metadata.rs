use super::*;

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
fn unchanged_distant_composition_preserves_unfinished_url_metadata_through_word_end_history() {
    let mut session = EditorSession::open("head\n\nbuffer\n\n\n\ntail");
    let mut view = ReferenceView::new("head\n\nbuffer\n\n\n\ntail");
    view.apply(
        session
            .replace(Revision(0), range(14, 14), "https://x.test/a", &mut |_| {
                Ok(())
            })
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "head\n\nbuffer\n\nhttps://x.test/a\n\ntail"
    );
    assert!(session
        .project(Revision(1), range(14, 30))
        .unwrap()
        .links
        .is_empty());
    session
        .compose(Revision(1), range(14, 30), "https://x.test/a")
        .unwrap();
    view.apply(
        session
            .replace(Revision(1), range(30, 30), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(
        session.source_text(),
        "head\n\nbuffer\n\nhttps://x.test/a \n\ntail"
    );
    assert_eq!(
        session
            .project(Revision(2), range(14, 30))
            .unwrap()
            .links
            .len(),
        1
    );
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(
        session.source_text(),
        "head\n\nbuffer\n\nhttps://x.test/a\n\ntail"
    );
    assert_eq!(view.text, session.source_text());
    assert!(
        session
            .project(Revision(3), range(14, 30))
            .unwrap()
            .links
            .is_empty(),
        "Undo must restore the unfinished URL in its actual source window"
    );
    view.apply(session.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(
        session.source_text(),
        "head\n\nbuffer\n\nhttps://x.test/a \n\ntail"
    );
    assert_eq!(
        session
            .project(Revision(4), range(14, 30))
            .unwrap()
            .links
            .len(),
        1
    );
}

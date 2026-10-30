use super::*;

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
fn delimiters_inside_typed_urls_remain_url_characters_and_only_trailing_ones_are_trimmed() {
    for (typed, href) in [
        ("https://x.test/*a* ok", "https://x.test/*a"),
        ("www.x.test/_a_ ok", "http://www.x.test/_a"),
    ] {
        let mut session = EditorSession::open("");
        let mut view = ReferenceView::new("");
        let mut expected = String::new();
        for ch in typed.chars() {
            let at = view.text.len();
            expected.push(ch);
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
            assert_eq!(view.text, expected, "typed URL prefix {expected:?}");
        }
        assert_eq!(session.source_text(), typed);
        let projection = session
            .project(session.revision(), range(0, typed.len()))
            .unwrap();
        assert!(projection.runs.iter().all(|run| run.formats.is_empty()));
        assert_eq!(projection.links.len(), 1);
        assert_eq!(projection.links[0].destination, href);
        assert_eq!(
            EditorSession::open(&session.source_text()).display_text(),
            typed
        );
    }
}

#[test]
fn an_outside_emphasis_closer_at_url_end_waits_for_word_end_including_exact_history() {
    let mut session = EditorSession::open("");
    let mut view = ReferenceView::new("");
    let mut typed = String::new();
    for ch in "x *b https://x.test/a*".chars() {
        let at = view.text.len();
        typed.push(ch);
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
        assert_eq!(
            view.text, typed,
            "delimiter conversion occurred before word end"
        );
        assert!(session
            .project(session.revision(), range(0, view.text.len()))
            .unwrap()
            .links
            .is_empty());
    }
    view.apply(
        session
            .replace(session.revision(), range(22, 22), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "x b https://x.test/a ");
    assert_eq!(session.source_text(), "x *b https://x.test/a* ");
    let links = session
        .project(session.revision(), range(0, 21))
        .unwrap()
        .links;
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].range, range(4, 20));
    assert_eq!(links[0].destination, "https://x.test/a");
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(view.text, "x *b https://x.test/a*");
    assert_eq!(session.source_text(), "x *b https://x.test/a*");
    view.apply(
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(view.text, "x b https://x.test/a ");
    assert_eq!(session.source_text(), "x *b https://x.test/a* ");
}

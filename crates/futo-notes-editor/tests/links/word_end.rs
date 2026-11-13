use super::*;

/// Type `text` one character at a time at the end of the view: each key
/// writes exactly its bytes, and the view always equals a fresh open's.
fn type_each(session: &mut EditorSession, view: &mut ReferenceView, text: &str) {
    for ch in text.chars() {
        let before = session.source_text();
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
        assert_eq!(session.source_text(), format!("{before}{ch}"));
        assert_eq!(
            view.text,
            EditorSession::open(&session.source_text()).display_text()
        );
    }
}

fn links(session: &EditorSession, len: usize) -> Vec<(DisplayRange, String)> {
    session
        .project(session.revision(), range(0, len))
        .unwrap()
        .links
        .into_iter()
        .map(|link| (link.range, link.destination))
        .collect()
}

#[test]
fn a_typed_bare_url_is_a_link_at_once_and_keeps_its_source_through_history() {
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
    let youtube = vec![(range(4, 23), "https://youtube.com".to_owned())];
    assert_eq!(view.text, "see https://youtube.com");
    assert_eq!(session.source_text(), "see https://youtube.com");
    assert_eq!(links(&session, 23), youtube);
    view.apply(
        session
            .replace(Revision(1), range(23, 23), " ok", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "see https://youtube.com ok");
    assert_eq!(session.source_text(), "see https://youtube.com ok");
    assert_eq!(links(&session, 26), youtube);
    view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "see https://youtube.com");
    assert_eq!(view.text, "see https://youtube.com");
    assert_eq!(links(&session, 23), youtube);
    view.apply(session.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), "see https://youtube.com ok");
    assert_eq!(links(&session, 26), youtube);
}

#[test]
fn hand_typed_link_syntax_saves_as_typed_and_reads_as_a_link() {
    let mut session = EditorSession::open("");
    let mut view = ReferenceView::new("");
    type_each(&mut session, &mut view, "[t](https://x.test)");
    assert_eq!(view.text, "t");
    assert_eq!(
        links(&session, 1),
        vec![(range(0, 1), "https://x.test".to_owned())]
    );
    type_each(&mut session, &mut view, " ok");
    assert_eq!(view.text, "t ok");
    assert_eq!(session.source_text(), "[t](https://x.test) ok");
    assert_eq!(
        links(&session, 4),
        vec![(range(0, 1), "https://x.test".to_owned())]
    );
}

#[test]
fn a_hand_typed_angle_address_saves_as_typed_and_hides_its_brackets() {
    let mut session = EditorSession::open("");
    let mut view = ReferenceView::new("");
    type_each(&mut session, &mut view, "<https://x.test>");
    let address = vec![(range(0, 14), "https://x.test".to_owned())];
    assert_eq!(view.text, "https://x.test");
    assert_eq!(links(&session, 14), address);
    type_each(&mut session, &mut view, " ok");
    assert_eq!(view.text, "https://x.test ok");
    assert_eq!(session.source_text(), "<https://x.test> ok");
    assert_eq!(links(&session, 17), address);
}

#[test]
fn a_typed_emphasis_closer_at_url_end_reads_at_once_with_exact_history() {
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };
    struct Clock(AtomicU64);
    impl futo_notes_editor::HistoryClock for Clock {
        fn now(&self) -> std::time::Duration {
            std::time::Duration::from_millis(self.0.load(Ordering::Relaxed))
        }
    }
    for (typed, display, bold) in [
        ("x *b https://x.test/a*", "x b https://x.test/a", false),
        ("x **b https://x.test/a**", "x b https://x.test/a", true),
    ] {
        let clock = Arc::new(Clock(AtomicU64::new(0)));
        let mut session = EditorSession::open_with_clock("", clock.clone());
        let mut view = ReferenceView::new("");
        type_each(&mut session, &mut view, typed);
        assert_eq!(view.text, display);
        let url = vec![(range(4, 20), "https://x.test/a".to_owned())];
        assert_eq!(links(&session, 20), url);
        let format = if bold {
            futo_notes_editor::InlineFormat::Bold
        } else {
            futo_notes_editor::InlineFormat::Italic
        };
        assert!(session
            .project(session.revision(), range(0, 20))
            .unwrap()
            .runs
            .iter()
            .filter(|run| run.range.start.0 >= 2 && run.range.end.0 <= 20)
            .all(|run| run.formats.contains(&format)));
        clock.0.store(500, Ordering::Relaxed);
        view.apply(
            session
                .replace(session.revision(), range(20, 20), " ", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(view.text, format!("{display} "));
        assert_eq!(session.source_text(), format!("{typed} "));
        assert_eq!(links(&session, 21), url);
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(view.text, display);
        assert_eq!(session.source_text(), typed);
        view.apply(
            session
                .redo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(view.text, format!("{display} "));
        assert_eq!(session.source_text(), format!("{typed} "));
    }
}

#[test]
fn bold_over_a_typed_italic_url_keeps_both_through_history() {
    use futo_notes_editor::InlineFormat;
    let standard = EditorSession::open("__x \\*b https://x.test/a*__");
    assert_eq!(standard.display_text(), "x *b https://x.test/a*");
    let bold: Vec<_> = standard
        .project(Revision(0), range(0, 22))
        .unwrap()
        .runs
        .into_iter()
        .filter(|run| run.formats.contains(&InlineFormat::Bold))
        .map(|run| run.range)
        .collect();
    assert_eq!(bold, vec![range(0, 22)]);
    let mut session = EditorSession::open("");
    let mut view = ReferenceView::new("");
    type_each(&mut session, &mut view, "x *b https://x.test/a*");
    session.select(session.revision(), range(0, 20)).unwrap();
    view.apply(
        session
            .toggle_format(session.revision(), InlineFormat::Bold, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(view.text, "x b https://x.test/a");
    assert_eq!(session.source_text(), "**x *b https://x.test/a***");
    session.select(session.revision(), range(20, 20)).unwrap();
    view.apply(
        session
            .replace(session.revision(), range(20, 20), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "x b https://x.test/a ");
    assert_eq!(session.source_text(), "**x *b https://x.test/a*** ");
    let projection = session
        .project(session.revision(), range(0, view.text.len()))
        .unwrap();
    assert_eq!(projection.links[0].destination, "https://x.test/a");
    let italic: Vec<_> = projection
        .runs
        .iter()
        .filter(|run| run.formats.contains(&InlineFormat::Italic))
        .map(|run| run.range)
        .collect();
    assert_eq!(italic, vec![range(2, 20)]);
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "**x *b https://x.test/a***");
    assert_eq!(view.text, "x b https://x.test/a");
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "x *b https://x.test/a*");
    view.apply(
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "**x *b https://x.test/a***");
    view.apply(
        session
            .replace(session.revision(), range(20, 20), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "x b https://x.test/a ");
    assert_eq!(session.source_text(), "**x *b https://x.test/a*** ");
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
fn minimal_standard_pre_word_end_spelling_reopens_literal_delimiters_and_unchanged_url() {
    let source = "x \\*b https://x.test/a*";
    let session = EditorSession::open(source);
    assert_eq!(session.source_text(), source);
    assert_eq!(session.display_text(), "x *b https://x.test/a*");
    let link = session
        .inspect_link(Revision(0), range(5, 21))
        .unwrap()
        .unwrap();
    assert_eq!(link.range, range(5, 21));
    assert_eq!(link.destination, "https://x.test/a");
}

#[test]
fn loaded_or_reopened_escaped_openers_keep_literal_intent_at_url_word_end() {
    for (source, typed) in [
        ("x \\*b https://x.test/a*", " "),
        ("x \\*b ", "https://x.test/a* "),
    ] {
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new(&session.display_text());
        for ch in typed.chars() {
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
        assert_eq!(session.source_text(), "x \\*b https://x.test/a* ");
        assert_eq!(view.text, "x *b https://x.test/a* ");
        let projection = session
            .project(session.revision(), range(0, view.text.len()))
            .unwrap();
        assert!(projection.runs.iter().all(|run| run.formats.is_empty()));
        assert_eq!(projection.links.len(), 1);
        assert_eq!(projection.links[0].destination, "https://x.test/a");
        assert_eq!(
            EditorSession::open(&session.source_text()).display_text(),
            view.text
        );
    }
}

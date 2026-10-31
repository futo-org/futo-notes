//! One typed word owner survives an opaque Code guard until actual word end.
use super::*;
use futo_notes_editor::{Affinity, InlineFormat};

#[test]
fn typed_http_and_www_words_share_code_guard_lifetime_without_loaded_enrollment() {
    for (inner, destination, code_start, code_end, end) in [
        ("https://x.test/path", "https://x.test/path", 15, 20, 21),
        ("www.x.test/path", "http://www.x.test/path", 11, 16, 17),
    ] {
        let mut session = EditorSession::open("");
        let mut view = ReferenceView::new("");
        let unfinished = format!("<{inner}");
        let displayed = format!("<{inner}>");
        view.apply(
            session
                .replace(Revision(0), range(0, 0), &unfinished, &mut |_| Ok(()))
                .unwrap(),
        );
        view.apply(
            session
                .replace(Revision(1), range(end - 1, end - 1), ">", &mut |_| Ok(()))
                .unwrap(),
        );
        session
            .select_with_affinity(Revision(2), range(code_start, code_end), Affinity::Backward)
            .unwrap();
        view.apply(
            session
                .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        let guarded = session.source_text();
        session
            .select_with_affinity(Revision(3), range(end, end), Affinity::Forward)
            .unwrap();
        view.apply(
            session
                .replace(Revision(3), range(end, end), " ", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(view.text, format!("{displayed} "));
        assert!(session
            .project(Revision(4), range(0, end + 1))
            .unwrap()
            .links
            .is_empty());
        view.apply(session.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), guarded);
        session
            .select_with_affinity(Revision(5), range(code_start, code_end), Affinity::Backward)
            .unwrap();
        view.apply(
            session
                .toggle_format(Revision(5), InlineFormat::Code, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        let released = session.source_text();
        assert_eq!(view.text, displayed);
        assert!(session
            .project(Revision(6), range(0, end))
            .unwrap()
            .links
            .is_empty());
        let mut loaded = EditorSession::open(&released);
        assert_eq!(loaded.display_text(), displayed);
        assert!(loaded
            .project(Revision(0), range(0, end))
            .unwrap()
            .links
            .is_empty());
        loaded
            .select_with_affinity(Revision(0), range(end, end), Affinity::Forward)
            .unwrap();
        loaded
            .replace(Revision(0), range(end, end), " ", &mut |_| Ok(()))
            .unwrap();
        assert_eq!(loaded.display_text(), format!("{displayed} "));
        assert!(loaded
            .project(Revision(1), range(0, end + 1))
            .unwrap()
            .links
            .is_empty());
        session
            .select_with_affinity(Revision(6), range(end, end), Affinity::Forward)
            .unwrap();
        view.apply(
            session
                .replace(Revision(6), range(end, end), " ", &mut |_| Ok(()))
                .unwrap(),
        );
        let active = session.source_text();
        let link = session.inspect_link(Revision(7), range(1, 2)).unwrap();
        assert_eq!(
            link.as_ref().map(|link| link.destination.as_str()),
            Some(destination),
            "inner={inner:?}; guarded={guarded:?}; released={released:?}; active={active:?}"
        );
        assert_eq!(link.unwrap().range, range(1, end - 1));
        let reopened = EditorSession::open(&active);
        assert_eq!(reopened.display_text(), view.text);
        assert_eq!(
            reopened
                .inspect_link(Revision(0), range(1, 2))
                .unwrap()
                .unwrap()
                .destination,
            destination
        );
        view.apply(session.undo(Revision(7), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), released);
        assert!(session
            .project(Revision(8), range(0, end))
            .unwrap()
            .links
            .is_empty());
        view.apply(session.undo(Revision(8), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), guarded);
        assert!(session
            .project(Revision(9), range(0, end))
            .unwrap()
            .runs
            .iter()
            .any(|run| run.range == range(code_start, code_end)
                && run.formats.contains(&InlineFormat::Code)));
        view.apply(session.redo(Revision(9), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), released);
        view.apply(
            session
                .redo(Revision(10), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), active);
        assert_eq!(
            session
                .inspect_link(Revision(11), range(1, 2))
                .unwrap()
                .unwrap()
                .destination,
            destination
        );
    }
}

#[test]
fn typed_angle_word_end_has_a_pending_owner_before_any_code_command() {
    for (inner, destination) in [
        ("https://x.test/path", "https://x.test/path"),
        ("www.x.test/path", "http://www.x.test/path"),
    ] {
        let mut session = EditorSession::open("");
        let mut view = ReferenceView::new("");
        let unfinished = format!("<{inner}");
        let end = unfinished.len();
        view.apply(
            session
                .replace(Revision(0), range(0, 0), &unfinished, &mut |_| Ok(()))
                .unwrap(),
        );
        let opening_source = session.source_text();
        let opening_fresh = EditorSession::open(&opening_source);
        let opening_canonical = opening_fresh
            .inspect_link(Revision(0), range(1, 2))
            .unwrap();
        view.apply(
            session
                .replace(Revision(1), range(end, end), ">", &mut |_| Ok(()))
                .unwrap(),
        );
        let before = session.source_text();
        let fresh = EditorSession::open(&before);
        let canonical = fresh.inspect_link(Revision(0), range(1, 2)).unwrap();
        assert_eq!(view.text, format!("<{inner}>"));
        assert!(
            session
                .project(Revision(2), range(0, end + 1))
                .unwrap()
                .links
                .is_empty(),
            "inner={inner:?}; source={before:?}; canonical={canonical:?}"
        );
        view.apply(
            session
                .replace(Revision(2), range(end + 1, end + 1), " ", &mut |_| Ok(()))
                .unwrap(),
        );
        let link = session.inspect_link(Revision(3), range(1, 2)).unwrap();
        assert_eq!(
            link.as_ref().map(|link| link.destination.as_str()),
            Some(destination),
            "inner={inner:?}; opening_source={opening_source:?}; opening_canonical={opening_canonical:?}; before={before:?}; canonical={canonical:?}; after={:?}",
            session.source_text()
        );
        assert_eq!(view.text, format!("<{inner}> "));
    }
}

#[test]
fn the_raw_parser_requires_explicit_inner_www_source_after_a_literal_angle() {
    let observed: Vec<_> = [
        ("\\<www.x.test/path", "<www.x.test/path", None),
        (
            "<[www.x.test/path](<http://www.x.test/path>)>",
            "<www.x.test/path>",
            Some("http://www.x.test/path"),
        ),
    ]
    .into_iter()
    .map(|(source, display, expected)| {
        let loaded = EditorSession::open(source);
        let link = loaded.inspect_link(Revision(0), range(1, 2)).unwrap();
        (
            source,
            display,
            loaded.display_text(),
            link.map(|link| link.destination),
            expected,
        )
    })
    .collect();
    // Evaluate both independent standard-source candidates before asserting;
    // neither candidate discovers ownership in an existing live session.
    for (source, display, actual, destination, expected) in &observed {
        assert_eq!(actual, display, "source={source:?}; observed={observed:?}");
        assert_eq!(
            destination.as_deref(),
            *expected,
            "source={source:?}; observed={observed:?}"
        );
    }
}

fn assert_new_www_typing(character_by_character: bool, closing: bool, loaded_opener: bool) {
    let initial = if loaded_opener { "<" } else { "" };
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
    let clock = Arc::new(Clock(AtomicU64::new(0)));
    let mut session = EditorSession::open_with_clock(initial, clock.clone());
    let mut view = ReferenceView::new(initial);
    let input = if loaded_opener {
        "www.x.test/path"
    } else {
        "<www.x.test/path"
    };
    if character_by_character {
        for ch in input.chars() {
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
    } else {
        let at = view.text.len();
        view.apply(
            session
                .replace(session.revision(), range(at, at), input, &mut |_| Ok(()))
                .unwrap(),
        );
    }
    let opening_revision = session.revision();
    assert_eq!(session.source_text(), "<www.x.test/path");
    assert_eq!(view.text, "<www.x.test/path");
    let fresh = EditorSession::open(&session.source_text());
    assert!(fresh
        .inspect_link(Revision(0), range(1, 2))
        .unwrap()
        .is_none());
    if closing {
        // A real pause gives the handoff its own history group. Continuous
        // character typing intentionally remains one group under the contract.
        clock.0.store(500, Ordering::Relaxed);
        let at = view.text.len();
        view.apply(
            session
                .replace(session.revision(), range(at, at), ">", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(view.text, "<www.x.test/path>");
        assert!(session
            .inspect_link(session.revision(), range(1, 2))
            .unwrap()
            .is_none());
        let fresh = EditorSession::open(&session.source_text());
        assert_eq!(
            fresh
                .inspect_link(Revision(0), range(1, 2))
                .unwrap()
                .map(|link| link.destination),
            Some("http://www.x.test/path".into()),
            "new canonical pending source after closer: {:?}",
            session.source_text()
        );
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), "<www.x.test/path");
        assert!(session.revision().0 > opening_revision.0);
        view.apply(
            session
                .redo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
    }
    clock.0.store(1000, Ordering::Relaxed);
    let before_space = session.source_text();
    let at = view.text.len();
    view.apply(
        session
            .replace(session.revision(), range(at, at), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(
        view.text,
        if closing {
            "<www.x.test/path> "
        } else {
            "<www.x.test/path "
        }
    );
    assert_eq!(session.inspect_link(session.revision(), range(1, 2)).unwrap().map(|link| link.destination),
        Some("http://www.x.test/path".into()),
        "character_by_character={character_by_character}; closing={closing}; before={before_space:?}; source={:?}", session.source_text());
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), before_space);
    view.apply(
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let reopened = EditorSession::open(&session.source_text());
    assert_eq!(reopened.display_text(), view.text);
    assert_eq!(
        reopened
            .inspect_link(Revision(0), range(1, 2))
            .unwrap()
            .map(|link| link.destination),
        Some("http://www.x.test/path".into())
    );
}

#[test]
fn a_bulk_typed_www_word_hands_off_to_canonical_pending_at_its_new_closer() {
    assert_new_www_typing(false, true, false);
}
#[test]
fn character_typing_retains_www_origin_through_eligibility_closer_and_history() {
    assert_new_www_typing(true, true, false);
}
#[test]
fn an_unclosed_character_typed_www_word_links_at_space_without_inventing_a_closer() {
    assert_new_www_typing(true, false, false);
}
#[test]
fn a_loaded_lone_angle_can_precede_a_genuinely_new_typed_www_word() {
    assert_new_www_typing(true, true, true);
}
#[test]
fn loaded_partial_or_complete_www_angles_never_adopt_typing_origin_from_a_suffix() {
    for (source, suffix) in [
        ("<w", "ww.x.test/path> "),
        ("<www.", "x.test/path> "),
        ("<www.x.test/path", "> "),
        ("<www.x.test/path>", " "),
    ] {
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new(source);
        for ch in suffix.chars() {
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
        assert_eq!(view.text, "<www.x.test/path> ");
        assert!(
            session
                .inspect_link(session.revision(), range(1, 2))
                .unwrap()
                .is_none(),
            "source={source:?}; suffix={suffix:?}"
        );
    }
}

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

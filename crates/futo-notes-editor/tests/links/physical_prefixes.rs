//! Canonical physical prefixes never become part of a typed URL word.
use super::*;
use futo_notes_editor::InlineFormat;

#[test]
fn formatted_angle_completion_keeps_inline_openers_distinct_from_physical_prefixes() {
    for (opening, expected) in [
        ("**seed**", "**<<https://x.test>>**"),
        ("> **seed**", "> **<<https://x.test>>**"),
        ("> > **seed**", "> > **<<https://x.test>>**"),
    ] {
        let standard = EditorSession::open(expected);
        assert_eq!(standard.display_text(), "<https://x.test>");
        assert_eq!(
            standard
                .inspect_link(Revision(0), range(1, 2))
                .unwrap()
                .unwrap()
                .destination,
            "https://x.test"
        );
        let mut session = EditorSession::open(opening);
        let mut view = ReferenceView::new("seed");
        view.apply(
            session
                .replace(Revision(0), range(0, 4), "<https://x.test", &mut |_| Ok(()))
                .unwrap(),
        );
        view.apply(
            session
                .replace(Revision(1), range(15, 15), ">", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(view.text, "<https://x.test>");
        assert!(session
            .project(Revision(2), range(0, 16))
            .unwrap()
            .links
            .is_empty());
        assert_eq!(session.source_text(), expected, "opening={opening:?}");
        let loaded = EditorSession::open(&session.source_text());
        assert_eq!(loaded.display_text(), view.text);
        assert_eq!(
            loaded
                .inspect_link(Revision(0), range(1, 2))
                .unwrap()
                .unwrap()
                .destination,
            "https://x.test"
        );
        let query = loaded.project(Revision(0), range(0, 16)).unwrap();
        assert_eq!(
            query
                .runs
                .iter()
                .filter(|run| run.formats.contains(&InlineFormat::Bold))
                .map(|run| run.range)
                .collect::<Vec<_>>(),
            vec![range(0, 16)]
        );
        view.apply(session.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(view.text, "<https://x.test");
        view.apply(session.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(session.source_text(), expected);
        assert!(session
            .inspect_link(Revision(4), range(1, 2))
            .unwrap()
            .is_none());
    }
}

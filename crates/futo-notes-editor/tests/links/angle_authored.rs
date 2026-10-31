use super::*;
use futo_notes_editor::InlineFormat;

#[test]
fn code_preserves_authored_active_angle_links_and_titles_instead_of_retiring_them() {
    for (source, title) in [
        ("<<https://x.test>>", None),
        ("<[https://x.test](https://x.test 'Title')>", Some("Title")),
    ] {
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new("<https://x.test>");
        assert_eq!(session.display_text(), view.text);
        let before = session.project(Revision(0), range(0, 16)).unwrap().links;
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].destination, "https://x.test");
        assert_eq!(before[0].title.as_deref(), title);
        session.select(Revision(0), range(1, 15)).unwrap();
        view.apply(
            session
                .toggle_format(Revision(0), InlineFormat::Code, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(view.text, "<https://x.test>");
        let query = session.project(session.revision(), range(0, 16)).unwrap();
        assert_eq!(query.links, before);
        let code: Vec<_> = query
            .runs
            .iter()
            .filter(|run| run.formats.contains(&InlineFormat::Code))
            .map(|run| run.range)
            .collect();
        assert_eq!(code, vec![range(1, 15)]);
        let changed = session.source_text();
        let reopened = EditorSession::open(&changed);
        assert_eq!(reopened.display_text(), view.text);
        assert_eq!(
            reopened.project(Revision(0), range(0, 16)).unwrap().links,
            before
        );
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), source);
        assert_eq!(
            session
                .project(session.revision(), range(0, 16))
                .unwrap()
                .links,
            before
        );
        view.apply(
            session
                .redo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), changed);
        assert_eq!(
            session
                .project(session.revision(), range(0, 16))
                .unwrap()
                .links,
            before
        );
    }
}

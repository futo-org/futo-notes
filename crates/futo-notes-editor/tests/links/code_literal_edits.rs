//! User edits retire the Code guard without inventing loaded source ownership.
use super::*;
use futo_notes_editor::{InlineFormat, InputAction};

#[test]
fn deleting_the_last_code_content_releases_only_the_live_word_end_guard() {
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
            .replace_action(
                Revision(3),
                range(15, 20),
                "",
                InputAction::Isolated,
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test>");
    let deleted = session.source_text();
    let query = session.project(Revision(4), range(0, 16)).unwrap();
    assert!(query.links.is_empty());
    assert!(query
        .runs
        .iter()
        .all(|run| !run.formats.contains(&InlineFormat::Code)));
    let mut loaded = EditorSession::open(&deleted);
    loaded
        .replace(Revision(0), range(16, 16), " ", &mut |_| Ok(()))
        .unwrap();
    assert!(loaded
        .project(Revision(1), range(0, 17))
        .unwrap()
        .links
        .is_empty());
    session.select(Revision(4), range(16, 16)).unwrap();
    view.apply(
        session
            .replace(Revision(4), range(16, 16), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<https://x.test> ");
    let link = session
        .inspect_link(Revision(5), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(link.destination, "https://x.test");
    assert_eq!(link.range, range(1, 15));
    view.apply(session.undo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), deleted);
    view.apply(session.undo(Revision(6), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), guarded);
    assert_eq!(view.text, "<https://x.test/path>");
    view.apply(session.redo(Revision(7), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), deleted);
    session.select(Revision(8), range(16, 16)).unwrap();
    view.apply(
        session
            .replace(Revision(8), range(16, 16), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(
        session
            .inspect_link(Revision(9), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        "https://x.test"
    );
}

//! Actual deletion retires one literal owner while preserving an equal foreign word.
use super::*;
use futo_notes_editor::{InlineFormat, InputAction};

#[test]
fn a_non_uri_survivor_retires_only_the_deleted_owner_among_equal_live_words() {
    let literal = "<x.test/path> + <`https://`x.test/path>";
    let candidate = EditorSession::open(literal);
    assert_eq!(
        candidate.display_text(),
        "<x.test/path> + <https://x.test/path>"
    );
    let checked = candidate.project(Revision(0), range(0, 37)).unwrap();
    assert!(checked.links.is_empty());
    assert_eq!(
        checked
            .runs
            .iter()
            .filter(|run| run.formats.contains(&InlineFormat::Code))
            .map(|run| run.range)
            .collect::<Vec<_>>(),
        vec![range(17, 25)]
    );

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
    session.select(Revision(2), range(1, 9)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    view.apply(
        session
            .replace(Revision(3), range(21, 21), " + ", &mut |_| Ok(()))
            .unwrap(),
    );
    view.apply(
        session
            .replace(
                Revision(4),
                range(24, 24),
                "<https://x.test/path",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    view.apply(
        session
            .replace(Revision(5), range(44, 44), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    session.select(Revision(6), range(25, 33)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(6), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let guarded = session.source_text();
    assert_eq!(view.text, "<https://x.test/path> + <https://x.test/path>");
    assert!(session
        .project(Revision(7), range(0, 45))
        .unwrap()
        .links
        .is_empty());

    view.apply(
        session
            .replace_action(
                Revision(7),
                range(1, 9),
                "",
                InputAction::Isolated,
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(view.text, "<x.test/path> + <https://x.test/path>");
    assert_eq!(session.selection(), range(1, 1));
    let retired = session.source_text();
    assert_eq!(retired, literal);
    let query = session.project(Revision(8), range(0, 37)).unwrap();
    assert!(query.links.is_empty());
    assert_eq!(
        query
            .runs
            .iter()
            .filter(|run| run.formats.contains(&InlineFormat::Code))
            .map(|run| run.range)
            .collect::<Vec<_>>(),
        vec![range(17, 25)]
    );
    let fresh = EditorSession::open(&retired);
    assert_eq!(fresh.display_text(), view.text);
    assert!(fresh
        .project(Revision(0), range(0, 37))
        .unwrap()
        .links
        .is_empty());
    view.apply(session.undo(Revision(8), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), guarded);
    view.apply(session.redo(Revision(9), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), retired);

    session.select(Revision(10), range(17, 25)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(10), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert!(session
        .project(Revision(11), range(0, 37))
        .unwrap()
        .links
        .is_empty());
    session.select(Revision(11), range(37, 37)).unwrap();
    view.apply(
        session
            .replace(Revision(11), range(37, 37), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<x.test/path> + <https://x.test/path> ");
    let active = session.project(Revision(12), range(0, 38)).unwrap();
    assert_eq!(active.links.len(), 1);
    assert_eq!(active.links[0].range, range(17, 36));
    assert_eq!(active.links[0].destination, "https://x.test/path");
    assert!(session
        .inspect_link(Revision(12), range(1, 2))
        .unwrap()
        .is_none());
    view.apply(
        session
            .undo(Revision(12), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    view.apply(
        session
            .undo(Revision(13), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), retired);
    view.apply(
        session
            .undo(Revision(14), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), guarded);
    assert_eq!(view.text, "<https://x.test/path> + <https://x.test/path>");
}

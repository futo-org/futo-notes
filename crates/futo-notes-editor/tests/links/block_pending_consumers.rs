//! Structural consumers must prepare retained transient fields before acceptance.
use super::*;
use futo_notes_editor::{BlockCommand, InlineFormat};

#[test]
fn a_divider_transports_the_live_code_scalar_into_its_unchanged_right_body() {
    let shown = "pre \n\u{fffc}\n\n<https://x.test/path>";
    let candidate = EditorSession::open("pre&#32;\n***\n\n<https\\://x.test`/path`>");
    assert_eq!(candidate.display_text(), shown);
    let candidate_query = candidate.project(Revision(0), range(0, 31)).unwrap();
    assert!(candidate_query.links.is_empty());
    assert!(candidate_query
        .runs
        .iter()
        .any(|run| run.range == range(25, 30) && run.formats.contains(&InlineFormat::Code)));
    let mut session = EditorSession::open("pre ");
    let mut view = ReferenceView::new("pre ");
    view.apply(
        session
            .replace(
                Revision(0),
                range(4, 4),
                "<https://x.test/path",
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    view.apply(
        session
            .replace(Revision(1), range(24, 24), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    session.select(Revision(2), range(19, 24)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(2), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let guarded = session.source_text();
    let mut accepts = 0;
    view.apply(
        session
            .block_command(Revision(3), range(4, 4), BlockCommand::Divider, &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(view.text, shown);
    let divided = session.source_text();
    let fresh = EditorSession::open(&divided);
    assert_eq!(fresh.display_text(), shown);
    let fresh_query = fresh.project(Revision(0), range(0, 31)).unwrap();
    assert!(fresh_query.links.is_empty());
    assert!(fresh_query
        .runs
        .iter()
        .any(|run| run.range == range(25, 30) && run.formats.contains(&InlineFormat::Code)));
    session.select(Revision(4), range(25, 30)).unwrap();
    view.apply(
        session
            .toggle_format(Revision(4), InlineFormat::Code, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    let released = session.source_text();
    session.select(Revision(5), range(31, 31)).unwrap();
    view.apply(
        session
            .replace(Revision(5), range(31, 31), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "pre \n\u{fffc}\n\n<https://x.test/path> ");
    let links = session.project(Revision(6), range(0, 32)).unwrap().links;
    assert_eq!(
        links.len(),
        1,
        "divided={divided:?}; released={released:?}; source={:?}",
        session.source_text()
    );
    assert_eq!(links[0].destination, "https://x.test/path");
    assert_eq!(links[0].range, range(11, 30));
    view.apply(session.undo(Revision(6), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), released);
    view.apply(session.undo(Revision(7), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), divided);
    view.apply(session.undo(Revision(8), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), guarded);
    assert_eq!(view.text, "pre <https://x.test/path>");
}

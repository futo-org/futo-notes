//! Divider validates reference eligibility in its real final parent.
use super::*;
use futo_notes_editor::BlockCommand;

#[test]
fn divider_keeps_a_newly_exposed_definition_literal_and_its_distant_reference_unresolved() {
    let original = "prefix [id]: /target 'T'\n\n[one][id]";
    let expected = "prefix \n***\n\n\\[id]: /target 'T'\n\n[one][id]";
    let shown = "prefix \n\u{fffc}\n\n[id]: /target 'T'\n\n[one][id]";
    let candidate = EditorSession::open(expected);
    assert_eq!(candidate.display_text(), shown);
    assert!(candidate
        .project(Revision(0), range(0, shown.len()))
        .unwrap()
        .links
        .is_empty());
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new(original);
    assert_eq!(session.display_text(), original);
    session.select(Revision(0), range(2, 2)).unwrap();
    let mut accepts = 0;
    view.apply(
        session
            .block_command(Revision(0), range(7, 7), BlockCommand::Divider, &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(
        view.text,
        shown,
        "actual source={:?}",
        session.source_text()
    );
    assert_eq!(session.source_text(), expected);
    assert_eq!(session.selection(), range(12, 12));
    assert!(session
        .project(Revision(1), range(0, shown.len()))
        .unwrap()
        .links
        .is_empty());
    let loaded = EditorSession::open(&session.source_text());
    assert_eq!(loaded.display_text(), shown);
    assert!(loaded
        .project(Revision(0), range(0, shown.len()))
        .unwrap()
        .links
        .is_empty());
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, original);
    assert_eq!(session.selection(), range(2, 2));
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(session.selection(), range(12, 12));
}

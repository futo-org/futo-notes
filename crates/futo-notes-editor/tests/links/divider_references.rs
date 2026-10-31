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

#[test]
fn divider_keeps_a_semantic_shortcut_and_existing_winner_duplicate_title_exact() {
    let original =
        "prefix [id]: /target 'T'\n\n[one][id]\n\n[id]: /first 'First'\n\n[id]: /second 'Later'";
    let expected = "prefix \n***\n\n[id][id]: /target 'T'\n\n[one][id]\n\n[id]: /first 'First'\n\n[id]: /second 'Later'";
    let shown = "prefix \n\u{fffc}\n\nid: /target 'T'\n\none\n\n\n\n[id]: /second 'Later'";
    let candidate = EditorSession::open(expected);
    assert_eq!(candidate.display_text(), shown);
    let expected_links = candidate
        .project(Revision(0), range(0, shown.len()))
        .unwrap()
        .links;
    assert_eq!(expected_links.len(), 2);
    assert!(expected_links
        .iter()
        .all(|link| link.destination == "/first" && link.title.as_deref() == Some("First")));
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("prefix id: /target 'T'\n\none\n\n\n\n[id]: /second 'Later'");
    assert_eq!(session.display_text(), view.text);
    view.apply(
        session
            .block_command(Revision(0), range(7, 7), BlockCommand::Divider, &mut |_| {
                Ok(())
            })
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(
        session
            .project(Revision(1), range(0, shown.len()))
            .unwrap()
            .links,
        expected_links
    );
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), expected);
    assert_eq!(
        session
            .project(Revision(3), range(0, shown.len()))
            .unwrap()
            .links,
        expected_links
    );
}

#[test]
fn ordinary_divider_does_not_scan_distant_reference_definitions_or_uses() {
    let mut measured = Vec::new();
    for count in [20, 200] {
        let original = format!(
            "alpha beta\n\nbuffer\n\n{}[keep]: /kept 'T'",
            "[other][keep]\n\n".repeat(count)
        );
        let mut session = EditorSession::open(&original);
        let change = session
            .block_command(Revision(0), range(6, 6), BlockCommand::Divider, &mut |_| {
                Ok(())
            })
            .unwrap()
            .unwrap();
        assert_eq!(
            session.source_text(),
            original.replacen("alpha beta", "alpha \n***\n\nbeta", 1)
        );
        measured.push(change.work);
    }
    assert_eq!(measured[0], measured[1]);
}

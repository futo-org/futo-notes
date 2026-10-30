use super::*;

#[test]
fn a_full_reference_label_edits_locally_without_rewriting_its_definition_or_title() {
    let original = "see [teh __docs__][id]\r\n\r\n[id]: <https://x.test/a> 'Title'\r\n\r\ntail";
    let corrected = "see [the __docs__][id]\r\n\r\n[id]: <https://x.test/a> 'Title'\r\n\r\ntail";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("see teh docs\r\n\r\ntail");
    assert_eq!(session.display_text(), view.text);
    let link = session
        .inspect_link(Revision(0), range(5, 6))
        .unwrap()
        .unwrap();
    assert_eq!(link.range, range(4, 12));
    assert_eq!(link.destination, "https://x.test/a");
    assert_eq!(link.title.as_deref(), Some("Title"));
    view.apply(
        session
            .replace(Revision(0), range(4, 7), "the", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(session.source_text(), corrected);
    assert_eq!(view.text, "see the docs\r\n\r\ntail");
    assert_eq!(EditorSession::open(corrected).display_text(), view.text);
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), corrected);
}

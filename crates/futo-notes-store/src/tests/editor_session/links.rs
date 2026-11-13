use super::*;

#[test]
fn link_edit_keeps_selection_history_and_saves_exactly() {
    let root = TestRoot::new();
    let store = store(&root);
    let original = "[teh __docs__](https://old.test 'Title')\r\n";
    store.create("", "links", original).unwrap();
    let mut session = store.open_editor("links").unwrap();
    session.replace(Revision(0), range(0, 3), "the").unwrap();
    session
        .select_with_affinity(
            Revision(1),
            range(1, 2),
            futo_notes_editor::Affinity::Forward,
        )
        .unwrap();
    let before = session.project(Revision(1), range(0, 10)).unwrap();
    assert_eq!(
        session.source_text(),
        "[the __docs__](https://old.test 'Title')\r\n"
    );
    assert_eq!(session.selection(), range(1, 2));
    assert_eq!(session.project(Revision(1), range(0, 10)).unwrap(), before);
    session
        .set_link(Revision(1), range(1, 2), "https://x.test")
        .unwrap()
        .unwrap();
    let updated = "[the __docs__](https://x.test 'Title')\r\n";
    assert_eq!(session.source_text(), updated);
    session.undo(Revision(2)).unwrap().unwrap();
    assert_eq!(
        session.source_text(),
        "[the __docs__](https://old.test 'Title')\r\n"
    );
    session.redo(Revision(3)).unwrap().unwrap();
    session.checkpoint().unwrap();
    drop(session);
    let mut recovered = store.open_editor("links").unwrap();
    assert_eq!(recovered.source_text(), updated);
    assert_eq!(recovered.display_text(), "the docs\r\n");
    assert_eq!(
        recovered
            .inspect_link(recovered.revision(), range(1, 2))
            .unwrap()
            .unwrap()
            .destination,
        "https://x.test"
    );
    recovered.checkpoint().unwrap();
    assert_eq!(store.read("links").unwrap(), updated);
}

mod typed_origin;

#[test]
fn atomic_label_and_destination_edit_saves_and_reopens_as_one_history_action() {
    let root = TestRoot::new();
    let store = store(&root);
    let original = "before [old](https://old.test 'T') after\r\n";
    store.create("", "labels", original).unwrap();
    let mut session = store.open_editor("labels").unwrap();
    session
        .edit_link(Revision(0), range(8, 9), "資料 [one]", "/new")
        .unwrap()
        .unwrap();
    let edited = session.source_text();
    assert_eq!(session.display_text(), "before 資料 [one] after\r\n");
    session.undo(Revision(1)).unwrap().unwrap();
    assert_eq!(session.source_text(), original);
    session.redo(Revision(2)).unwrap().unwrap();
    assert_eq!(session.source_text(), edited);
    session.checkpoint().unwrap();
    drop(session);
    let mut reopened = store.open_editor("labels").unwrap();
    assert_eq!(reopened.source_text(), edited);
    let link = reopened
        .inspect_link(Revision(0), range(7, 10))
        .unwrap()
        .unwrap();
    assert_eq!(link.destination, "/new");
    assert_eq!(link.title.as_deref(), Some("T"));
    assert!(reopened.undo(Revision(0)).unwrap().is_none());
    assert_eq!(store.read("labels").unwrap(), edited);
}

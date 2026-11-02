use super::*;

#[test]
fn header_tag_edits_save_exact_bytes() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "tags", "#a\n\nbody #z").unwrap();
    let mut session = store.open_editor("tags").unwrap();
    assert_eq!(session.header_tags().unwrap(), ["#a"]);
    assert_eq!(session.tags().unwrap(), ["#a", "#z"]);
    assert_eq!(session.source_text(), "#a\n\nbody #z");
    session.add_header_tag(Revision(0), "b").unwrap().unwrap();
    session
        .remove_header_tag(Revision(1), "a")
        .unwrap()
        .unwrap();
    session.checkpoint().unwrap();
    drop(session);
    let recovered = store.open_editor("tags").unwrap();
    assert_eq!(recovered.source_text(), "#b\n\nbody #z");
}

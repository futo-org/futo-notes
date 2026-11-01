use super::*;

#[test]
fn header_tag_edits_are_recovered_and_failed_acceptance_changes_nothing() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "tags", "#a\n\nbody #z").unwrap();
    let disk = Arc::new(Mutex::new(storage::Disk::default()));
    let mut session = store
        .open_editor_with_recovery("tags", storage::options(&disk))
        .unwrap();
    assert_eq!(session.header_tags().unwrap(), ["#a"]);
    assert_eq!(session.tags().unwrap(), ["#a", "#z"]);
    disk.lock().unwrap().fault = Some(storage::Fault::Append);
    assert!(matches!(
        session.add_header_tag(Revision(0), "b"),
        Err(EditorStoreError::RecoveryAppend(_))
    ));
    assert_eq!(session.source_text(), "#a\n\nbody #z");
    disk.lock().unwrap().fault = None;
    session.resume_recovery().unwrap();
    session.add_header_tag(Revision(0), "b").unwrap().unwrap();
    session
        .remove_header_tag(Revision(1), "a")
        .unwrap()
        .unwrap();
    session.flush_recovery().unwrap();
    drop(session);
    let recovered = store
        .open_editor_with_recovery("tags", storage::options(&disk))
        .unwrap();
    assert_eq!(recovered.source_text(), "#b\n\nbody #z");
}

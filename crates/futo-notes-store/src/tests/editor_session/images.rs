use super::*;

#[test]
fn image_insertion_is_one_recovered_edit_and_a_reopened_session_rejects_old_claims() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "pics", "ab").unwrap();
    let disk = Arc::new(Mutex::new(storage::Disk::default()));
    let mut session = store
        .open_editor_with_recovery("pics", storage::options(&disk))
        .unwrap();
    let claim = session.image_claim().unwrap();
    disk.lock().unwrap().fault = Some(storage::Fault::Append);
    assert!(matches!(
        session.insert_image(Revision(0), claim, "image-1.png", ""),
        Err(EditorStoreError::RecoveryAppend(_))
    ));
    assert_eq!(session.source_text(), "ab");
    disk.lock().unwrap().fault = None;
    session.resume_recovery().unwrap();
    session
        .insert_image(Revision(0), claim, "image-1.png", "")
        .unwrap()
        .unwrap();
    let atoms = session
        .project(Revision(1), range(0, session.display_text().len()))
        .unwrap()
        .atoms;
    assert_eq!(atoms[0].image.as_ref().unwrap().destination, "image-1.png");
    session.flush_recovery().unwrap();
    drop(session);

    let mut recovered = store
        .open_editor_with_recovery("pics", storage::options(&disk))
        .unwrap();
    assert_eq!(recovered.source_text(), "![](image-1.png)ab");
    assert!(matches!(
        recovered.insert_image(Revision(1), claim, "image-2.png", ""),
        Err(EditorStoreError::Editor(
            futo_notes_editor::EditorError::StaleClaim
        ))
    ));
}

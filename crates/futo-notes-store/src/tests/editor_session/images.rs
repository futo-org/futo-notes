use super::*;

#[test]
fn image_insertion_is_one_edit_and_a_reopened_session_rejects_old_claims() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "pics", "ab").unwrap();
    let mut session = store.open_editor("pics").unwrap();
    let claim = session.image_claim().unwrap();
    assert_eq!(session.source_text(), "ab\n");
    session
        .insert_image(Revision(0), claim, "image-1.png", "")
        .unwrap()
        .unwrap();
    let atoms = session
        .project(Revision(1), range(0, session.display_text().len()))
        .unwrap()
        .atoms;
    assert_eq!(atoms[0].image.as_ref().unwrap().destination, "image-1.png");
    session.checkpoint().unwrap();
    drop(session);

    let mut recovered = store.open_editor("pics").unwrap();
    assert_eq!(recovered.source_text(), "![](image-1.png)ab\n");
    assert!(matches!(
        recovered.insert_image(recovered.revision(), claim, "image-2.png", ""),
        Err(EditorStoreError::Editor(
            futo_notes_editor::EditorError::StaleClaim
        ))
    ));
}

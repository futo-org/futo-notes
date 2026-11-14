//! A native recovery retry reuses its (recovered) copy.
use super::*;

#[test]
fn a_native_recovery_retry_does_not_duplicate_a_copy_with_a_busy_lease() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("FolderF", "Fnote", "base").unwrap();
    store
        .create("", "Fnote (recovered)", "reservation")
        .unwrap();
    let reservation = store.open_editor("Fnote (recovered)").unwrap();
    let mut editor = store.open_editor("FolderF/Fnote").unwrap();
    editor.replace(Revision(0), range(4, 4), " after").unwrap();
    // External removals leave both attachments alive, including the lease on
    // the root id the recovery will allocate.
    fs::remove_file(root.0.join("Fnote (recovered).md")).unwrap();
    fs::remove_file(root.0.join("FolderF/Fnote.md")).unwrap();
    fs::remove_dir(root.0.join("FolderF")).unwrap();
    for _ in 0..2 {
        assert!(matches!(
            editor.checkpoint(),
            Err(crate::editor_session::EditorStoreError::SessionAlreadyOpen)
        ));
        assert_eq!(editor.id(), "FolderF/Fnote");
        assert_eq!(store.snapshot().notes.len(), 1);
        assert_eq!(store.read("Fnote (recovered)").unwrap(), "base after");
    }
    drop(reservation);
    let saved = editor.checkpoint().unwrap();
    assert_eq!(editor.id(), "Fnote (recovered)");
    assert_eq!(store.snapshot().notes.len(), 1);
    assert_eq!(saved.mutation.unwrap().removed, ["FolderF/Fnote"]);
    assert!(!root.0.join("FolderF").exists());
}

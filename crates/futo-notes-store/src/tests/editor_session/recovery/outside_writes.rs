use super::*;

#[test]
fn intentional_restore_of_old_checkpoint_preserves_recovered_draft_and_complete_mutation() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "one\r\ntwo  ").unwrap();
    {
        let mut editor = store.open_editor("plain").unwrap();
        editor.replace(Revision(0), range(5, 8), "three").unwrap();
        assert_eq!(editor.source_text(), "one\r\nthree  ");
    }
    // An intentional restore is meaningful even when it restores the exact
    // checkpoint against which the pending draft was originally accepted.
    let restored = store.write("plain", "one\r\ntwo  ", None).unwrap();
    assert_eq!(restored.final_id.as_deref(), Some("plain"));
    let mut editor = store.open_editor("plain").unwrap();
    assert_eq!(editor.source_text(), "one\r\nthree  ");
    let saved = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = saved.disposition else {
        panic!("intentional restore must survive pending draft recovery");
    };
    let mutation = saved.mutation.unwrap();
    assert_eq!(mutation.final_id.as_deref(), Some(parked_id.as_str()));
    assert_eq!(mutation.upserted.len(), 1);
    assert_eq!(mutation.upserted[0].note.id, parked_id);
    assert_eq!(mutation.upserted[0].note.preview, "one three");
    assert!(mutation.removed.is_empty());
    assert!(mutation.renamed.is_empty());
    assert!(mutation.folders.is_empty());
    assert!(mutation.relinked.is_empty());
    assert!(mutation.warnings.is_empty());
    assert_eq!(mutation.final_folder, None);
    assert_eq!(store.read("plain").unwrap(), "one\r\ntwo  ");
    assert_eq!(store.read(&parked_id).unwrap(), "one\r\nthree  ");
    let snapshot = store.snapshot();
    assert_eq!(snapshot.notes.len(), 2);
    assert_eq!(
        snapshot.notes[mutation.upserted[0].position as usize].id,
        parked_id
    );
    drop(editor);
    for _ in 0..2 {
        store.open_editor("plain").unwrap().checkpoint().unwrap();
        assert_eq!(store.snapshot().notes.len(), 2);
        assert_eq!(store.read("plain").unwrap(), "one\r\ntwo  ");
    }
}

#[test]
fn replacement_after_committed_checkpoint_does_not_retire_the_only_draft() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    editor.set_retirement_failure(true);
    assert!(matches!(
        editor.checkpoint(),
        Err(EditorStoreError::CheckpointCommitted { .. })
    ));
    store.write("plain", "plain", None).unwrap();
    editor.set_retirement_failure(false);
    let saved = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = saved.disposition else {
        panic!("retry must preserve replacement and draft");
    };
    assert_eq!(store.read("plain").unwrap(), "plain");
    assert_eq!(store.read(&parked_id).unwrap(), "plain!");
    assert_eq!(
        saved.mutation.unwrap().final_id.as_deref(),
        Some(parked_id.as_str())
    );
    assert_eq!(store.snapshot().notes.len(), 2);
}

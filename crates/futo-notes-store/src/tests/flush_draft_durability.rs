use super::*;

// A save whose bytes landed but whose directory fsync failed is not durable, so
// it must not be acknowledged. The bytes are installed, so the note is stamped;
// the retry finds the draft on disk, and must sync the directory itself before
// it reports the save, and hand the shell the mutation the failed save could not.
#[cfg(unix)]
#[test]
fn a_flush_whose_directory_sync_failed_is_only_acknowledged_after_a_sync() {
    use futo_notes_core::files::vault_fs::fail_directory_sync_on_call;

    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "base text", None).unwrap();
    set_file_mtime_ms(&root.0.join("note.md"), 1_000).unwrap();

    fail_directory_sync_on_call(1);
    let error = store
        .flush_draft("note", "base text", "draft text")
        .unwrap_err();

    assert!(error.contains("sync directory after write"), "{error}");
    assert_eq!(store.read("note").unwrap(), "draft text");
    let stamped = file_mtime_ms(&fs::metadata(root.0.join("note.md")).unwrap());
    assert!(stamped > 1_000, "the landed bytes are stamped: {stamped}");

    // The retry does not trust the draft on disk: it syncs, and that can fail too.
    fail_directory_sync_on_call(1);
    let error = store
        .flush_draft("note", "base text", "draft text")
        .unwrap_err();
    assert!(error.contains("sync directory"), "{error}");

    let result = store
        .flush_draft("note", "base text", "draft text")
        .unwrap();
    assert_eq!(result.disposition, FlushDisposition::Converged);
    let mutation = result
        .mutation
        .expect("the shell is owed the failed save's mutation");
    assert_eq!(mutation.upserted[0].note.id, "note");

    // Owed once; an ordinary converged flush carries none.
    let again = store
        .flush_draft("note", "base text", "draft text")
        .unwrap();
    assert!(again.mutation.is_none());
}

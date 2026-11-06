//! A saved, unedited native session follows the authoritative source.
use super::*;

#[test]
fn clean_checkpoint_adopts_peer_source_and_undo_keeps_the_peer() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(0, 0), "local ").unwrap();
    editor.checkpoint().unwrap();
    editor
        .select_with_affinity(
            editor.revision(),
            range(6, 11),
            futo_notes_editor::Affinity::Forward,
        )
        .unwrap();
    store
        .write("plain", "local first\n\npeer second\n", None)
        .unwrap();
    let result = editor.checkpoint().unwrap();
    assert_eq!(result.disposition, FlushDisposition::Converged);
    assert!(result.mutation.is_none());
    assert_eq!(editor.id(), "plain");
    assert_eq!(editor.source_text(), "local first\n\npeer second\n");
    assert_eq!(editor.selection(), range(6, 11));
    assert_eq!(editor.take_coordinated_changes().unwrap().len(), 1);
    assert_eq!(editor.save_status().saved, editor.revision());
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "first\n\npeer second\n");
    editor.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), "first\n\npeer second\n");
}

#[test]
fn clean_checkpoint_does_not_recreate_a_peer_deleted_note() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(0, 0), "local ").unwrap();
    editor.checkpoint().unwrap();
    std::fs::remove_file(root.0.join("plain.md")).unwrap();
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Converged
    );
    assert_eq!(store.read_existing("plain").unwrap(), None);
    assert_eq!(editor.source_text(), "local first\n\nsecond\n");
    assert!(editor.take_coordinated_changes().unwrap().is_empty());
    // A subsequent real edit still has the existing edit-wins promise.
    editor.replace(editor.revision(), range(6, 6), "!").unwrap();
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Recreated
    );
    assert_eq!(store.read("plain").unwrap(), "local !first\n\nsecond\n");
}

#[test]
fn clean_refresh_read_failure_keeps_source_history_and_baseline_for_retry() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(0, 0), "local ").unwrap();
    editor.checkpoint().unwrap();
    let saved = editor.save_status().saved;
    let path = root.0.join("plain.md");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(editor.checkpoint().is_err());
    assert_eq!(editor.source_text(), "local first\n\nsecond\n");
    assert_eq!(editor.save_status().saved, saved);
    assert!(editor.save_delay().is_some());
    assert!(editor.take_coordinated_changes().unwrap().is_empty());
    std::fs::remove_dir(&path).unwrap();
    std::fs::write(&path, "local first\n\npeer second\n").unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(editor.source_text(), "local first\n\npeer second\n");
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "first\n\npeer second\n");
}

#[test]
fn clean_refresh_with_ambiguous_saved_undo_follows_disk_without_a_conflict_copy() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(0, 5), "saved").unwrap();
    editor.checkpoint().unwrap();
    store.write("plain", "REMOTE\n\nsecond\n", None).unwrap();
    let result = editor.checkpoint().unwrap();
    // Nothing is dirty: the saved edit is already the superseded disk version,
    // so the session follows the authoritative source (its history cannot be
    // rebased unambiguously and is dropped) instead of minting a stale copy.
    assert_eq!(result.disposition, FlushDisposition::Converged);
    assert_eq!(editor.id(), "plain");
    assert_eq!(editor.source_text(), "REMOTE\n\nsecond\n");
    assert_eq!(editor.take_coordinated_changes().unwrap().len(), 1);
    assert_eq!(editor.save_status().saved, editor.revision());
    assert!(editor.undo(editor.revision()).unwrap().is_none());
    assert_eq!(store.read("plain").unwrap(), "REMOTE\n\nsecond\n");
    assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 1);
}

#[test]
fn oversized_clean_session_follows_a_peer_edit_instead_of_parking_its_stale_text() {
    let root = TestRoot::new();
    let store = store(&root);
    let base = format!("first\n\n{}\n", "x".repeat(1024 * 1024));
    store.create("", "plain", &base).unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    let remote = base.replacen("first", "REMOTE", 1);
    store.write("plain", &remote, None).unwrap();
    let result = editor.checkpoint().unwrap();
    assert_eq!(result.disposition, FlushDisposition::Converged);
    assert_eq!(editor.id(), "plain");
    assert_eq!(editor.source_text(), remote);
    assert_eq!(store.read("plain").unwrap(), remote);
    assert_eq!(editor.save_status().saved, editor.revision());
    assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 1);
    // The adopted source is the baseline: a later edit saves in place.
    editor.replace(editor.revision(), range(0, 0), "!").unwrap();
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    assert_eq!(store.read("plain").unwrap(), format!("!{remote}"));
}

#[test]
fn clean_session_with_front_matter_follows_outside_body_and_metadata_edits() {
    let root = TestRoot::new();
    let store = store(&root);
    store
        .create("", "plain", "---\ntags: a\n---\nfirst\n\nsecond\n")
        .unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    for remote in [
        "---\ntags: a\n---\nREMOTE\n\nsecond\n",
        "---\ntags: a, b\n---\nREMOTE\n\nsecond\n",
    ] {
        store.write("plain", remote, None).unwrap();
        let result = editor.checkpoint().unwrap();
        assert_eq!(result.disposition, FlushDisposition::Converged);
        assert_eq!(editor.id(), "plain");
        assert_eq!(editor.source_text(), remote);
        assert_eq!(editor.save_status().saved, editor.revision());
        assert!(editor.save_delay().is_none());
    }
    assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 1);
    editor.close().unwrap();
}

//! A rename made outside the app, which the file watcher reports to
//! `observe_external_change`: an attachment on the old name follows it once
//! its file is gone, or once the only file left there is its own recreation.
use super::*;

fn watcher_saw(store: &LocalNoteStore, from: &str, to: &str) {
    store.observe_external_change(FileChange::Renamed {
        from: format!("{from}.md"),
        to: format!("{to}.md"),
    });
}

/// The watcher's report of a move it could not confirm, the old name having
/// been written again before its halves were read.
fn watcher_guessed(store: &LocalNoteStore, from: &str, to: &str) {
    store.observe_recreated_move(&format!("{from}.md"), &format!("{to}.md"));
}

fn sync_reported(store: &LocalNoteStore, from: &str, to: &str) {
    let rename = crate::NoteRename {
        from: from.into(),
        to: to.into(),
    };
    store.follow_sync_renames(&[rename], &[]).unwrap();
}

fn rename_outside(root: &TestRoot, from: &str, to: &str) {
    std::fs::rename(
        root.0.join(format!("{from}.md")),
        root.0.join(format!("{to}.md")),
    )
    .unwrap();
}

fn draft(store: &LocalNoteStore) -> StoreEditorSession<'_> {
    store.create("", "plain", "base").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(4, 4), " draft").unwrap();
    editor
}

fn conflict_copies(store: &LocalNoteStore) -> Vec<String> {
    let ids = store.snapshot().notes.into_iter().map(|note| note.id);
    ids.filter(|id| id.contains("conflict")).collect()
}

#[test]
fn a_rename_the_watcher_saw_moves_the_attachment_and_its_next_save_writes_there() {
    let root = TestRoot::new();
    let store = store(&root);
    let mut editor = draft(&store);

    rename_outside(&root, "plain", "finder");
    watcher_saw(&store, "plain", "finder");

    assert_eq!(editor.id(), "finder");
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    assert_eq!(store.read("finder").unwrap(), "base draft");
    assert!(!root.0.join("plain.md").exists());
}

#[test]
fn a_rename_whose_old_name_is_still_on_disk_is_not_followed() {
    let root = TestRoot::new();
    let store = store(&root);
    let editor = draft(&store);
    // A stale event, or the old name came back holding other bytes.
    std::fs::write(root.0.join("copy.md"), "base").unwrap();
    watcher_saw(&store, "plain", "copy");
    assert_eq!(editor.id(), "plain");
}

#[test]
fn a_chain_of_renames_is_followed_in_event_order() {
    let root = TestRoot::new();
    let store = store(&root);
    let mut editor = draft(&store);
    // Both renames land before the watcher's events reach the store.
    rename_outside(&root, "plain", "middle");
    rename_outside(&root, "middle", "final");

    watcher_saw(&store, "plain", "middle");
    assert_eq!(editor.id(), "middle");
    watcher_saw(&store, "middle", "final");
    assert_eq!(editor.id(), "final");

    editor.checkpoint().unwrap();
    assert_eq!(store.read("final").unwrap(), "base draft");
    assert!(!root.0.join("plain.md").exists());
    assert!(!root.0.join("middle.md").exists());
}

#[test]
fn a_save_that_recreated_the_old_name_first_is_adopted() {
    let root = TestRoot::new();
    let observer = Arc::new(RecordingObserver::default());
    let store = LocalNoteStore::with_before_write(root.0.clone(), observer.clone());
    let mut editor = draft(&store);
    rename_outside(&root, "plain", "finder");
    // The save timer fires before the watcher's event: the old name is gone,
    // so the save recreates it with the draft.
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Recreated
    );

    observer.0.lock().unwrap().clear();
    watcher_saw(&store, "plain", "finder");

    assert_eq!(editor.id(), "finder");
    assert!(!root.0.join("plain.md").exists());
    // The watcher must hear this unlink as the app's own, not the open note
    // deleted outside it.
    assert_eq!(
        *observer.0.lock().unwrap(),
        [vec![FileChange::Removed("plain.md".into())]]
    );
    // The renamed file still held the bytes from before the recreation: a
    // fast-forward, not a conflict copy.
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    assert_eq!(store.read("finder").unwrap(), "base draft");
    assert!(conflict_copies(&store).is_empty());
}

/// FSEvents and ReadDirectoryChangesW pair a rename's halves by which name is
/// gone, so a save that recreated the old name hid the move from the store: the
/// open note stayed on the old name, and both files stayed on disk.
#[test]
fn a_move_the_watcher_could_only_guess_adopts_the_recreation() {
    let root = TestRoot::new();
    let store = store(&root);
    let mut editor = draft(&store);
    rename_outside(&root, "plain", "finder");
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Recreated
    );

    watcher_guessed(&store, "plain", "finder");

    assert_eq!(editor.id(), "finder");
    assert!(!root.0.join("plain.md").exists());
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    assert_eq!(store.read("finder").unwrap(), "base draft");
    assert!(conflict_copies(&store).is_empty());
}

/// A guess is never a rename: a name that is simply gone, or an old name that
/// another program wrote, moves no editor.
#[test]
fn a_move_the_watcher_guessed_changes_nothing_unless_it_is_the_recreation() {
    let root = TestRoot::new();
    let store = store(&root);
    let mut editor = draft(&store);
    std::fs::write(root.0.join("copy.md"), "base").unwrap();
    // The old name still holds the attachment's baseline: not a recreation.
    watcher_guessed(&store, "plain", "copy");
    assert_eq!(editor.id(), "plain");

    rename_outside(&root, "plain", "finder");
    watcher_guessed(&store, "plain", "finder");
    assert_eq!(editor.id(), "plain");

    editor.checkpoint().unwrap();
    std::fs::write(root.0.join("plain.md"), "written elsewhere").unwrap();
    watcher_guessed(&store, "plain", "finder");
    assert_eq!(editor.id(), "plain");
    assert_eq!(store.read("plain").unwrap(), "written elsewhere");
}

#[test]
fn removing_an_adopted_recreation_ends_the_pending_rename_into_it() {
    let root = TestRoot::new();
    crate::rename_journal::set_rename_scope(&root.0, Some("collection")).unwrap();
    let store = store(&root);
    store.create("", "origin", "base").unwrap();
    store.rename("origin", "plain").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(4, 4), " draft").unwrap();
    rename_outside(&root, "plain", "finder");
    editor.checkpoint().unwrap();

    watcher_saw(&store, "plain", "finder");

    assert!(!root.0.join("plain.md").exists());
    // As for any store delete: a later note at `plain` must not inherit the
    // moved note's sync identity.
    let ended = crate::rename_journal::with_rename_journal(&root.0, |journal| {
        journal.intents().into_iter().all(|intent| intent.ended)
    })
    .unwrap();
    assert!(ended);
}

#[test]
fn a_recreation_saved_again_before_the_report_is_still_adopted() {
    let root = TestRoot::new();
    let store = store(&root);
    let mut editor = draft(&store);
    rename_outside(&root, "plain", "finder");
    editor.checkpoint().unwrap();
    // The attachment's own next save writes the recreation again.
    editor.replace(Revision(1), range(10, 10), "!").unwrap();
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );

    watcher_saw(&store, "plain", "finder");

    assert_eq!(editor.id(), "finder");
    assert!(!root.0.join("plain.md").exists());
    editor.checkpoint().unwrap();
    assert_eq!(store.read("finder").unwrap(), "base draft!");
    assert!(conflict_copies(&store).is_empty());
}

#[test]
fn a_recreation_someone_else_wrote_over_is_not_adopted() {
    let root = TestRoot::new();
    let store = store(&root);
    let mut editor = draft(&store);
    rename_outside(&root, "plain", "finder");
    editor.checkpoint().unwrap();
    // Another program wrote the recreated note: it is that program's note now.
    std::fs::write(root.0.join("plain.md"), "written elsewhere").unwrap();

    watcher_saw(&store, "plain", "finder");

    assert_eq!(editor.id(), "plain");
    assert_eq!(store.read("plain").unwrap(), "written elsewhere");
    assert_eq!(store.read("finder").unwrap(), "base");
}

#[test]
fn a_recreation_is_kept_when_the_renamed_file_is_not_there() {
    let root = TestRoot::new();
    let store = store(&root);
    let mut editor = draft(&store);
    // Deleted outside, not renamed: the save recreates it.
    std::fs::remove_file(root.0.join("plain.md")).unwrap();
    editor.checkpoint().unwrap();

    // A rename report with no file behind it (an undo in Finder, a replayed event).
    watcher_saw(&store, "plain", "finder");

    assert_eq!(editor.id(), "plain");
    assert_eq!(store.read("plain").unwrap(), "base draft");
}

#[test]
fn a_case_only_rename_is_followed() {
    let root = TestRoot::new();
    let store = store(&root);
    let mut editor = draft(&store);
    // A case-insensitive disk still finds `plain.md`: it is the same file.
    rename_outside(&root, "plain", "Plain");
    watcher_saw(&store, "plain", "Plain");

    assert_eq!(editor.id(), "Plain");
    editor.checkpoint().unwrap();
    let names: Vec<_> = std::fs::read_dir(&root.0)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.eq_ignore_ascii_case("plain.md"))
        .collect();
    assert_eq!(names, ["Plain.md"]);
    assert_eq!(store.read("Plain").unwrap(), "base draft");
}

#[test]
fn a_title_rename_after_an_outside_move_lands_beside_the_moved_file() {
    let root = TestRoot::new();
    let store = store(&root);
    let mut editor = draft(&store);
    std::fs::create_dir(root.0.join("Archive")).unwrap();
    rename_outside(&root, "plain", "Archive/plain");
    watcher_saw(&store, "plain", "Archive/plain");
    assert_eq!(
        editor.rename_title("Plan").unwrap().final_id,
        "Archive/Plan"
    );
}

/// The recreation's removal can fail (its folder refuses writes): then nothing
/// moves. Followed first, the attachment kept the recreation as its baseline,
/// its draft read as saved, and the renamed note never got it.
/// Another session holds the renamed note (the incoming note of a switch in
/// flight). The recreation was removed before that refused the move: the
/// attachment stayed on the old name, clean, and its edit was on disk nowhere.
#[test]
fn a_recreation_is_kept_while_another_session_holds_the_renamed_note() {
    let root = TestRoot::new();
    let store = store(&root);
    let mut editor = draft(&store);
    rename_outside(&root, "plain", "finder");
    editor.checkpoint().unwrap();
    let incoming = store.open_editor("finder").unwrap();

    watcher_saw(&store, "plain", "finder");

    assert_eq!(editor.id(), "plain");
    assert_eq!(store.read("plain").unwrap(), "base draft");
    drop(incoming);
    watcher_saw(&store, "plain", "finder");
    assert_eq!(editor.id(), "finder");
    editor.checkpoint().unwrap();
    assert_eq!(store.read("finder").unwrap(), "base draft");
}

#[cfg(unix)]
#[test]
fn a_recreation_that_cannot_be_removed_changes_nothing_until_it_can() {
    use std::os::unix::fs::PermissionsExt;
    let root = TestRoot::new();
    let store = store(&root);
    store.create("ro", "plain", "base").unwrap();
    let mut editor = store.open_editor("ro/plain").unwrap();
    editor.replace(Revision(0), range(4, 4), " draft").unwrap();
    std::fs::rename(root.0.join("ro/plain.md"), root.0.join("finder.md")).unwrap();
    editor.checkpoint().unwrap();
    let folder = root.0.join("ro");
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();

    watcher_saw(&store, "ro/plain", "finder");
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(editor.id(), "ro/plain");
    assert_eq!(store.read("ro/plain").unwrap(), "base draft");
    // Reported again once it can be removed, the recreation is adopted.
    watcher_saw(&store, "ro/plain", "finder");
    assert_eq!(editor.id(), "finder");
    editor.checkpoint().unwrap();
    assert_eq!(store.read("finder").unwrap(), "base draft");
}

#[test]
fn a_rename_sync_reported_as_a_delete_and_a_create_is_followed() {
    let root = TestRoot::new();
    let store = store(&root);
    let mut editor = draft(&store);
    // The peer's rename reached this device as its own delete and create: the
    // pull removed `plain` and downloaded `renamed`; no file moved here.
    std::fs::remove_file(root.0.join("plain.md")).unwrap();
    std::fs::write(root.0.join("renamed.md"), "base").unwrap();

    sync_reported(&store, "plain", "renamed");

    assert_eq!(editor.id(), "renamed");
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    assert_eq!(store.read("renamed").unwrap(), "base draft");
    assert!(!root.0.join("plain.md").exists());
    // Reported again (a later cycle, or a sync move already followed): nothing changes.
    sync_reported(&store, "plain", "renamed");
    assert_eq!(editor.id(), "renamed");
}

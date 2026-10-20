use super::*;

// A create whose chosen id is taken by a concurrent writer in the
// allocate→install window must NOT overwrite that writer's file — it re-suffixes
// and both contents survive (A1).
#[test]
fn create_never_clobbers_a_concurrent_writer_at_the_chosen_id() {
    let root = TestRoot::new();
    let store = store(&root);
    store.set_install_window_hook(plant_once(&root, "peer wrote here"));

    let mutation = store.create("", "Note", "my new note").unwrap();
    let final_id = mutation.final_id.clone().unwrap();

    assert_ne!(
        final_id, "Note",
        "create must re-suffix away from the taken id"
    );
    assert_eq!(
        store.read("Note").unwrap(),
        "peer wrote here",
        "the concurrent writer's file must not be clobbered"
    );
    assert_eq!(store.read(&final_id).unwrap(), "my new note");
}

// The create path registers NO watcher suppression (D2, two-strikes redesign):
// there is no suppress-vs-install ordering to get wrong. Even a collision retry
// registers nothing — the own-create echo is harmless (idempotent reconcile),
// and a peer's colliding event is processed normally with no suppression to eat
// it. (Rename/delete/write-existing keep their pre-write suppression.)
#[test]
fn the_create_path_registers_no_watcher_suppression() {
    let root = TestRoot::new();
    let recorder = Arc::new(RecordingObserver::default());
    let store = LocalNoteStore::with_before_write(root.0.clone(), recorder.clone());
    store.set_install_window_hook(plant_once(&root, "peer"));

    store.create("", "Note", "mine").unwrap(); // forces a collision retry

    assert!(
        recorder.0.lock().unwrap().is_empty(),
        "a brand-new create must register no watcher suppression"
    );
}

#[test]
fn importing_markdown_preserves_the_filename_and_never_clobbers() {
    let vault = TestRoot::new();
    let external = TestRoot::new();
    let source = external.0.join("grocery list.markdown");
    fs::write(&source, "- milk\n").unwrap();
    let store = store(&vault);

    let first = store.import_markdown(&source).unwrap();
    let second = store.import_markdown(&source).unwrap();

    assert_eq!(first.final_id.as_deref(), Some("grocery list"));
    assert_eq!(second.final_id.as_deref(), Some("grocery list-2"));
    assert_eq!(store.read("grocery list").unwrap(), "- milk\n");
    assert_eq!(store.read("grocery list-2").unwrap(), "- milk\n");
    assert_eq!(fs::read_to_string(source).unwrap(), "- milk\n");
}

#[test]
fn importing_rejects_non_markdown_files() {
    let vault = TestRoot::new();
    let external = TestRoot::new();
    let source = external.0.join("grocery list.txt");
    fs::write(&source, "not Markdown").unwrap();

    let error = store(&vault).import_markdown(&source).unwrap_err();

    assert_eq!(error, "only .md and .markdown files can be imported");
    assert!(vault.0.read_dir().unwrap().next().is_none());
}

#[test]
fn markdown_path_policy_accepts_both_extensions_case_insensitively() {
    assert!(is_markdown_path(Path::new("note.md")));
    assert!(is_markdown_path(Path::new("note.MARKDOWN")));
    assert!(!is_markdown_path(Path::new("note.txt")));
    assert!(!is_markdown_path(Path::new("note")));
}

// A divergent parked backup (install-complete crash boundary: old backup bytes
// ≠ live) must be parked as a VISIBLE recovered note, never left eligible for a
// canonical restore that would resurrect the note if the user later deletes the
// live one (C1, the F1/S2 resurrection class).
#[test]
fn a_divergent_backup_is_parked_visibly_and_never_resurrects_a_deleted_note() {
    let root = TestRoot::new();
    let store = store(&root);
    fs::write(root.0.join("Welcome.md"), "installed").unwrap();
    fs::write(root.0.join(".sf-bak-1-1-1"), "old superseded").unwrap();
    fs::write(root.0.join(".sf-bak-1-1-1.path"), "Welcome.md").unwrap();

    store.bootstrap().unwrap();

    assert_eq!(
        store.read("Welcome").unwrap(),
        "installed",
        "live note untouched"
    );
    let recovered: Vec<_> = store
        .snapshot()
        .notes
        .into_iter()
        .filter(|note| note.id.contains("recovered"))
        .collect();
    assert_eq!(
        recovered.len(),
        1,
        "the divergent backup surfaced as a visible note"
    );
    assert_eq!(store.read(&recovered[0].id).unwrap(), "old superseded");
    assert!(
        !root.0.join(".sf-bak-1-1-1").exists(),
        "backup renamed into the recovered note"
    );
    assert!(
        !root.0.join(".sf-bak-1-1-1.path").exists(),
        "sidecar consumed"
    );

    // The user deletes the live note; a later bootstrap must NOT resurrect it.
    store.delete("Welcome").unwrap();
    store.bootstrap().unwrap();
    assert!(
        !store.exists("Welcome"),
        "a deleted note must not be resurrected"
    );
}

// Parking a recovered backup must NOT clobber a note an external writer created
// at the chosen recovered name in the window — it re-suffixes, and both the
// planted note and the recovered content survive (E1, the A1/B2 TOCTOU class).
#[test]
fn parking_a_recovered_backup_never_clobbers_a_concurrent_writer() {
    let root = TestRoot::new();
    let store = store(&root);
    fs::write(root.0.join("Welcome.md"), "live").unwrap();
    fs::write(root.0.join(".sf-bak-1-1-1"), "stranded").unwrap();
    fs::write(root.0.join(".sf-bak-1-1-1.path"), "Welcome.md").unwrap();
    store.set_install_window_hook(plant_once(&root, "peer at recovered name"));

    store.bootstrap().unwrap();

    assert_eq!(
        store.read("Welcome").unwrap(),
        "live",
        "live note untouched"
    );
    // The planted note at the first-chosen recovered name is intact...
    assert_eq!(
        store.read("Welcome (recovered)").unwrap(),
        "peer at recovered name",
        "the concurrent writer at the recovered name must not be clobbered"
    );
    // ...and the recovered content re-suffixed to the next name.
    assert_eq!(store.read("Welcome (recovered)-2").unwrap(), "stranded");
}

// A crash after the park hard_link but before the backup unlink leaves the
// recovered note in place with the backup still sidecar'd. A re-sweep must
// recognize the already-parked content and finish cleanup, NOT create a second
// recovered copy (E2).
#[test]
fn re_parking_after_a_crash_does_not_duplicate_the_recovered_note() {
    let root = TestRoot::new();
    let store = store(&root);
    fs::write(root.0.join("Welcome.md"), "live").unwrap();
    // The recovered note already landed; backup + sidecar weren't cleaned up.
    fs::write(root.0.join("Welcome (recovered).md"), "old superseded").unwrap();
    fs::write(root.0.join(".sf-bak-1-1-1"), "old superseded").unwrap();
    fs::write(root.0.join(".sf-bak-1-1-1.path"), "Welcome.md").unwrap();

    store.bootstrap().unwrap();

    let recovered: Vec<_> = store
        .snapshot()
        .notes
        .into_iter()
        .filter(|note| note.id.contains("recovered"))
        .collect();
    assert_eq!(
        recovered.len(),
        1,
        "re-sweep must not duplicate the recovered note"
    );
    assert_eq!(store.read("Welcome (recovered)").unwrap(), "old superseded");
    assert!(!root.0.join(".sf-bak-1-1-1").exists(), "backup cleaned up");
    assert!(
        !root.0.join(".sf-bak-1-1-1.path").exists(),
        "sidecar cleaned up"
    );
}

// The park idempotency guard must match only a note THIS park could have
// produced (exact stem or its numeric suffix), not a merely similarly-named
// user note that happens to share content — else the backup for a genuinely new
// recovered note gets discarded instead of parked (F1).
#[test]
fn the_park_guard_does_not_confuse_a_similarly_named_note() {
    let root = TestRoot::new();
    let store = store(&root);
    fs::write(root.0.join("Welcome.md"), "live").unwrap();
    // A DISTINCT user note that only *starts with* the recovered stem.
    fs::write(root.0.join("Welcome (recovered) draft.md"), "stranded").unwrap();
    fs::write(root.0.join(".sf-bak-1-1-1"), "stranded").unwrap();
    fs::write(root.0.join(".sf-bak-1-1-1.path"), "Welcome.md").unwrap();

    store.bootstrap().unwrap();

    assert_eq!(
        store.read("Welcome (recovered)").unwrap(),
        "stranded",
        "the backup must still be parked as a NEW recovered note"
    );
    assert_eq!(
        store.read("Welcome (recovered) draft").unwrap(),
        "stranded",
        "the user's similarly-named note is untouched"
    );
    assert!(!root.0.join(".sf-bak-1-1-1").exists());
}

// If unlinking the backup fails in the guard's cleanup branch, the sidecar must
// be RETAINED and the failure surfaced (not silent success), so the next
// bootstrap retries — never a sidecar-less untracked backup (F2).
#[cfg(unix)]
#[test]
fn a_failed_backup_unlink_in_the_guard_retains_the_sidecar() {
    use std::os::unix::fs::PermissionsExt;
    let root = TestRoot::new();
    let store = store(&root);
    fs::write(root.0.join("Welcome.md"), "live").unwrap();
    // Already-parked state → the guard hits the cleanup branch.
    fs::write(root.0.join("Welcome (recovered).md"), "stranded").unwrap();
    fs::write(root.0.join(".sf-bak-1-1-1"), "stranded").unwrap();
    fs::write(root.0.join(".sf-bak-1-1-1.path"), "Welcome.md").unwrap();
    let original = fs::metadata(&root.0).unwrap().permissions();
    fs::set_permissions(&root.0, fs::Permissions::from_mode(0o555)).unwrap();
    let dac_enforced = fs::write(root.0.join(".probe"), b"x").is_err();
    if !dac_enforced {
        let _ = fs::remove_file(root.0.join(".probe"));
        fs::set_permissions(&root.0, original).unwrap();
        return;
    }

    let result = store.bootstrap().unwrap();

    fs::set_permissions(&root.0, original).unwrap();
    assert!(
        root.0.join(".sf-bak-1-1-1.path").exists(),
        "sidecar retained when the backup unlink failed"
    );
    assert!(
        result.warnings.iter().any(|w| w.contains("recovered note")),
        "the failed cleanup is surfaced, not silently swallowed"
    );
}

// A divergent backup in a subfolder is parked as a recovered note IN THAT
// subfolder, not at the vault root (D4).
#[test]
fn a_recovered_note_keeps_its_subfolder() {
    let root = TestRoot::new();
    let store = store(&root);
    let sub = root.0.join("Projects");
    fs::create_dir_all(&sub).unwrap();
    fs::write(sub.join("Notes.md"), "live").unwrap();
    fs::write(sub.join(".sf-bak-2-2-2"), "stranded").unwrap();
    fs::write(sub.join(".sf-bak-2-2-2.path"), "Notes.md").unwrap();

    store.bootstrap().unwrap();

    let recovered: Vec<_> = store
        .snapshot()
        .notes
        .into_iter()
        .filter(|note| note.id.contains("recovered"))
        .collect();
    assert_eq!(recovered.len(), 1);
    assert_eq!(
        recovered[0].folder, "Projects",
        "recovered note stays in its folder"
    );
    assert!(recovered[0].id.starts_with("Projects/"));
    assert_eq!(store.read(&recovered[0].id).unwrap(), "stranded");
}

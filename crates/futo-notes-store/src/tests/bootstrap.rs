use super::*;

#[test]
fn bootstrap_migrates_txt_collisions_once_before_returning_the_snapshot() {
    let root = TestRoot::new();
    fs::write(root.0.join("note.txt"), "legacy").unwrap();
    fs::write(root.0.join("note.md"), "markdown").unwrap();
    let store = store(&root);

    let result = store.bootstrap().unwrap();
    assert_eq!(result.migrated, 1);
    assert_eq!(result.seeded, 0);
    assert_eq!(store.read("note").unwrap(), "markdown");
    assert_eq!(store.read("note (imported)").unwrap(), "legacy");
    assert!(!root.0.join("note.txt").exists());
    assert!(root.0.join(".txt-migration-done").is_file());

    fs::write(root.0.join("late.txt"), "left alone").unwrap();
    assert_eq!(store.bootstrap().unwrap().migrated, 0);
    assert!(root.0.join("late.txt").is_file());
}

#[test]
fn bootstrap_seeds_only_a_truly_empty_vault() {
    let root = TestRoot::new();
    let store = store(&root);
    let first = store.bootstrap().unwrap();
    assert_eq!((first.seeded, first.snapshot.notes.len()), (1, 1));
    assert_eq!(first.snapshot.notes[0].id, WELCOME_NOTE_ID);
    assert_eq!(store.bootstrap().unwrap().seeded, 0);
}

/// One app launch: a fresh store over the same vault and the same app-data
/// index dir, the way every shell reopens it.
fn launch(vault: &TestRoot, index_dir: &std::path::Path) -> BootstrapResult {
    let observer: StatusObserver = Arc::new(|_| {});
    LocalNoteStore::new(vault.0.clone())
        .bootstrap_with_search(index_dir.to_owned(), observer)
        .unwrap()
}

// Feedback #52: deleting the Welcome note from an otherwise empty vault must
// stick across launches; the "seeded once" fact lives in app data, not in the
// vault.
#[test]
fn deleted_welcome_note_is_not_reseeded_on_the_next_launch() {
    let vault = TestRoot::new();
    let app_data = TestRoot::new();
    let index = app_data.0.join("search");

    let first = launch(&vault, &index);
    assert_eq!(first.seeded, 1);
    assert_eq!(first.snapshot.notes[0].id, WELCOME_NOTE_ID);

    store(&vault).delete(WELCOME_NOTE_ID).unwrap();
    let second = launch(&vault, &index);
    assert_eq!(second.seeded, 0);
    assert!(second.snapshot.notes.is_empty());
    assert!(!vault.0.join("Welcome.md").exists());
    // The marker lives in app data, never in the user's notes folder.
    assert!(app_data.0.join("search.welcome").is_file());
    assert!(fs::read_dir(&vault.0).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains("welcome")));
}

#[test]
fn vault_that_had_notes_on_first_launch_never_gets_welcome_after_being_emptied() {
    let vault = TestRoot::new();
    let app_data = TestRoot::new();
    let index = app_data.0.join("search");
    store(&vault).write("Mine", "body", None).unwrap();

    assert_eq!(launch(&vault, &index).seeded, 0);
    store(&vault).delete("Mine").unwrap();
    assert_eq!(launch(&vault, &index).seeded, 0);
}

// An install that predates the marker and already deleted Welcome has a search
// index from its earlier launches but no marker: it must not get Welcome once
// more on upgrade.
#[test]
fn upgrading_install_with_an_empty_vault_is_not_reseeded() {
    let vault = TestRoot::new();
    let app_data = TestRoot::new();
    let index = app_data.0.join("search");
    fs::create_dir_all(&index).unwrap();
    fs::write(index.join("meta.json"), "{}").unwrap();

    assert_eq!(launch(&vault, &index).seeded, 0);
    assert_eq!(launch(&vault, &index).seeded, 0);
}

// settings.md: Full reset returns the app to a fresh state, so the next launch
// shows Welcome again - once.
#[test]
fn full_reset_lets_the_next_launch_seed_welcome_once_more() {
    let vault = TestRoot::new();
    let app_data = TestRoot::new();
    let index = app_data.0.join("search");
    let observer: StatusObserver = Arc::new(|_| {});
    let live = LocalNoteStore::new(vault.0.clone());
    assert_eq!(
        live.bootstrap_with_search(index.clone(), observer)
            .unwrap()
            .seeded,
        1
    );

    live.reset().unwrap();
    assert_eq!(launch(&vault, &index).seeded, 1);
    store(&vault).delete(WELCOME_NOTE_ID).unwrap();
    assert_eq!(launch(&vault, &index).seeded, 0);
}

#[test]
fn startup_listing_preserves_engine_order_without_mutating_an_empty_vault() {
    let root = TestRoot::new();
    let store = store(&root);
    assert!(store.startup_listing().notes.is_empty());
    assert!(!store.exists(WELCOME_NOTE_ID));

    store.write("Older", "#old\nbody", Some(10)).unwrap();
    store.write("Folder/Newer", "#new\nbody", Some(20)).unwrap();
    let listing = store.startup_listing();

    assert_eq!(
        listing
            .notes
            .iter()
            .map(|note| note.id.as_str())
            .collect::<Vec<_>>(),
        ["Folder/Newer", "Older"]
    );
    assert_eq!(listing.notes[0].title, "Newer");
    assert_eq!(listing.notes[0].folder, "Folder");
    assert!(listing.folders.contains(&"Folder".to_owned()));
}

#[test]
fn snapshot_preserves_nested_markdown_layout_and_ignores_hidden_entries() {
    let root = TestRoot::new();
    let store = store(&root);
    store
        .write("Specs/Roadmap 1.4.1", "#tag\nbody", Some(10))
        .unwrap();
    fs::create_dir_all(root.0.join("Empty/Nested")).unwrap();
    fs::write(root.0.join("foreign.txt"), "not a note").unwrap();
    fs::write(root.0.join(".hidden.md"), "hidden").unwrap();

    let snapshot = store.snapshot();
    assert_eq!(snapshot.notes.len(), 1);
    assert_eq!(snapshot.notes[0].id, "Specs/Roadmap 1.4.1");
    assert_eq!(snapshot.notes[0].title, "Roadmap 1.4.1");
    assert_eq!(snapshot.notes[0].folder, "Specs");
    assert_eq!(snapshot.notes[0].tags, ["tag"]);
    assert_eq!(snapshot.folders, ["Empty", "Empty/Nested", "Specs"]);
}

#[test]
fn read_existing_distinguishes_an_empty_note_from_a_missing_note() {
    let root = TestRoot::new();
    let store = store(&root);
    fs::write(root.0.join("Empty.md"), "").unwrap();

    assert_eq!(store.read_existing("Empty").unwrap(), Some(String::new()));
    assert_eq!(store.read_existing("Missing").unwrap(), None);
    assert!(store.read_existing("../outside").is_err());
}

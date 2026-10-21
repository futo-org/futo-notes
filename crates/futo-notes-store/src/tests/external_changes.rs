use super::*;

#[test]
fn reported_external_changes_form_a_complete_authoritative_projection() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("old", "rename me", Some(1_000)).unwrap();
    store.write("deleted", "remove me", Some(2_000)).unwrap();
    store.write("untouched", "stay", Some(3_000)).unwrap();
    let before = ids_in_order(&store);

    fs::create_dir_all(root.0.join("Folder")).unwrap();
    fs::rename(root.0.join("old.md"), root.0.join("Folder/new.md")).unwrap();
    fs::write(root.0.join("created.md"), "# Fresh\nbody #new").unwrap();
    set_file_mtime_ms(&root.0.join("created.md"), 5_000).unwrap();
    fs::remove_file(root.0.join("deleted.md")).unwrap();

    let mutation = store
        .refresh_external_changes(
            &["created".to_owned()],
            &["deleted".to_owned()],
            &[NoteRename {
                from: "old".to_owned(),
                to: "Folder/new".to_owned(),
            }],
        )
        .unwrap();

    assert_eq!(mutation.removed, ["deleted", "old"]);
    assert_eq!(
        mutation.renamed,
        [NoteRename {
            from: "old".to_owned(),
            to: "Folder/new".to_owned(),
        }]
    );
    assert_eq!(
        mutation
            .upserted
            .iter()
            .map(|entry| entry.note.id.as_str())
            .collect::<Vec<_>>(),
        ["created", "Folder/new"]
    );
    assert_eq!(mutation.upserted[0].note.tags, ["new"]);
    assert_eq!(mutation.folders, ["Folder"]);
    assert_eq!(apply_as_shell(&before, &mutation), ids_in_order(&store));
}

#[test]
fn reported_external_update_moves_a_row_to_its_engine_owned_position() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("newer", "body", Some(2_000)).unwrap();
    store.write("older", "body", Some(1_000)).unwrap();
    let before = ids_in_order(&store);
    set_file_mtime_ms(&root.0.join("older.md"), 3_000).unwrap();

    let mutation = store
        .refresh_external_changes(&["older".to_owned()], &[], &[])
        .unwrap();

    assert_eq!(mutation.upserted[0].position, 0);
    assert_eq!(apply_as_shell(&before, &mutation), ids_in_order(&store));
}

#[test]
fn reported_categories_yield_to_the_authoritative_final_filesystem_state() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("vanished-update", "old", Some(1_000)).unwrap();
    store.write("reported-delete", "old", Some(2_000)).unwrap();
    store.write("rename-source", "old", Some(3_000)).unwrap();
    let before = ids_in_order(&store);

    fs::remove_file(root.0.join("vanished-update.md")).unwrap();
    fs::write(root.0.join("reported-delete.md"), "recreated draft").unwrap();
    fs::write(root.0.join("rename-source.md"), "recreated source").unwrap();

    let mutation = store
        .refresh_external_changes(
            &["vanished-update".to_owned()],
            &["reported-delete".to_owned()],
            &[NoteRename {
                from: "rename-source".to_owned(),
                to: "missing-target".to_owned(),
            }],
        )
        .unwrap();

    assert_eq!(mutation.removed, ["vanished-update", "missing-target"]);
    let upserted = mutation
        .upserted
        .iter()
        .map(|entry| (entry.note.id.as_str(), entry.note.preview.as_str()))
        .collect::<HashMap<_, _>>();
    assert_eq!(upserted["reported-delete"], "recreated draft");
    assert_eq!(upserted["rename-source"], "recreated source");
    assert_eq!(apply_as_shell(&before, &mutation), ids_in_order(&store));
}

#[test]
fn reported_external_changes_issue_scoped_search_notifications() {
    let root = TestRoot::new();
    let index = TestRoot::new();
    let store = store(&root);
    store
        .start_search(index.0.clone(), Arc::new(|_| {}))
        .unwrap();
    fs::write(root.0.join("created.md"), "zzexternal body").unwrap();
    store
        .refresh_external_changes(&["created".to_owned()], &[], &[])
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let hits = store.search("zzexternal", Some(10)).unwrap();
        if hits.iter().any(|hit| hit.note_id == "created") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "external create never reached search"
        );
        std::thread::sleep(Duration::from_millis(25));
    }

    fs::rename(root.0.join("created.md"), root.0.join("renamed.md")).unwrap();
    store
        .refresh_external_changes(
            &[],
            &[],
            &[NoteRename {
                from: "created".to_owned(),
                to: "renamed".to_owned(),
            }],
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let hits = store.search("zzexternal", Some(10)).unwrap();
        let has_old = hits.iter().any(|hit| hit.note_id == "created");
        let has_new = hits.iter().any(|hit| hit.note_id == "renamed");
        if has_new && !has_old {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "external rename left stale search rows"
        );
        std::thread::sleep(Duration::from_millis(25));
    }

    fs::remove_file(root.0.join("renamed.md")).unwrap();
    store
        .refresh_external_changes(&[], &["renamed".to_owned()], &[])
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if store.search("zzexternal", Some(10)).unwrap().is_empty() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "external delete left a search row"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

// A peer's `delete_folder` reaches this client as a pull that moves the folder's
// notes up and leaves the directory behind. The projection must prune the
// vacated directory exactly as the local delete/move workflows do, or every
// peer that syncs a folder deletion keeps a ghost empty folder forever.
#[test]
fn reported_external_changes_prune_the_directories_the_pull_vacated() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("Projects/Plans/roadmap", "body", None).unwrap();
    store
        .write("Projects/Plans/Deep/detail", "body", None)
        .unwrap();
    store.write("Projects/keep", "body", None).unwrap();

    // The sync engine has already applied the peer's folder deletion to disk:
    // both notes now live in `Projects`, and `Projects/Plans[/Deep]` are empty.
    fs::rename(
        root.0.join("Projects/Plans/roadmap.md"),
        root.0.join("Projects/roadmap.md"),
    )
    .unwrap();
    fs::rename(
        root.0.join("Projects/Plans/Deep/detail.md"),
        root.0.join("Projects/detail.md"),
    )
    .unwrap();

    let mutation = store
        .refresh_external_changes(
            &[],
            &[],
            &[
                NoteRename {
                    from: "Projects/Plans/roadmap".to_owned(),
                    to: "Projects/roadmap".to_owned(),
                },
                NoteRename {
                    from: "Projects/Plans/Deep/detail".to_owned(),
                    to: "Projects/detail".to_owned(),
                },
            ],
        )
        .unwrap();

    assert_eq!(mutation.folders, ["Projects"]);
    assert!(!root.0.join("Projects/Plans").exists());
    assert_eq!(store.snapshot().folders, ["Projects"]);
}

// Pruning is scoped to the ancestors the pull actually vacated — an empty folder
// the user deliberately created, and a still-populated one, both survive.
#[test]
fn reported_external_changes_keep_empty_folders_the_pull_never_touched() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create_folder("Ideas/Someday").unwrap();
    store.write("Projects/Plans/roadmap", "body", None).unwrap();
    store
        .write("Projects/Plans/Deep/detail", "body", None)
        .unwrap();
    store.write("Archive/old", "body", None).unwrap();

    // Only `roadmap` is pulled away; `Projects/Plans` still holds `Deep`.
    fs::rename(
        root.0.join("Projects/Plans/roadmap.md"),
        root.0.join("Projects/roadmap.md"),
    )
    .unwrap();

    let mutation = store
        .refresh_external_changes(
            &[],
            &[],
            &[NoteRename {
                from: "Projects/Plans/roadmap".to_owned(),
                to: "Projects/roadmap".to_owned(),
            }],
        )
        .unwrap();

    assert_eq!(
        mutation.folders,
        [
            "Archive",
            "Ideas",
            "Ideas/Someday",
            "Projects",
            "Projects/Plans",
            "Projects/Plans/Deep",
        ]
    );
    assert!(root.0.join("Ideas/Someday").is_dir());
}

#[test]
fn watcher_paths_are_registered_before_the_corresponding_disk_mutation() {
    let root = TestRoot::new();
    let observer = Arc::new(RecordingObserver::default());
    let store = LocalNoteStore::with_before_write(root.0.clone(), observer.clone());
    store.write("old", "body", None).unwrap();
    store.rename("old", "new").unwrap();

    let calls = observer.0.lock().unwrap();
    assert_eq!(calls[0], [FileChange::Changed("old.md".into())]);
    assert!(calls[1].contains(&FileChange::Renamed {
        from: "old.md".into(),
        to: "new.md".into(),
    }));
}

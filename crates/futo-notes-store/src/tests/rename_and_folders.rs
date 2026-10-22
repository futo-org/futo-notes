use super::*;

#[test]
fn rename_is_one_operation_that_moves_content_and_rewrites_resolvable_links() {
    let root = TestRoot::new();
    let store = store(&root);
    store
        .write("Lists/groceries", "self [[groceries]]", None)
        .unwrap();
    store.write("pointer", "see [[groceries]]", None).unwrap();

    let mutation = store
        .rename("Lists/groceries", "Archive/groceries")
        .unwrap();
    assert_eq!(mutation.renamed[0].to, "Archive/groceries");
    assert_eq!(
        store.read("Archive/groceries").unwrap(),
        "self [[Archive/groceries]]"
    );
    assert_eq!(store.read("pointer").unwrap(), "see [[Archive/groceries]]");
    assert!(!store.exists("Lists/groceries"));
}

// The collision check walks only the folders that can hold a folded twin
// (`vault::collision_candidates`), so it must still see a twin whose FOLDERS
// differ by case or Unicode normalization, at any depth — and keep ignoring a
// same-named note at a different depth, which never collided.
#[test]
fn collision_check_sees_folded_twins_behind_variant_folders_at_any_depth() {
    let root = TestRoot::new();
    let store = store(&root);
    fs::create_dir_all(root.0.join("Docs/Plans")).unwrap();
    fs::write(root.0.join("Docs/Plans/roadmap.md"), "one").unwrap();
    fs::create_dir_all(root.0.join("Caf\u{00E9}")).unwrap();
    fs::write(root.0.join("Caf\u{00E9}/menu.md"), "nfc").unwrap();

    assert!(
        store.write("docs/plans/Roadmap", "two", None).is_err(),
        "case-variant folders and leaf must collide"
    );
    assert!(
        store.write("Cafe\u{0301}/Menu", "nfd", None).is_err(),
        "an NFD folder name must collide with its NFC twin"
    );
    assert!(
        store.write("Docs/roadmap", "shallower", None).is_ok(),
        "a same-named note one level up is a different id"
    );
    assert!(
        store
            .write("Docs/Plans/Archive/roadmap", "deeper", None)
            .is_ok(),
        "a same-named note one level down is a different id"
    );
    assert_eq!(store.read("Docs/Plans/roadmap").unwrap(), "one");
    assert_eq!(store.read("Caf\u{00E9}/menu").unwrap(), "nfc");

    // Unique-id allocation consults the same candidates: a create whose folded
    // id is taken behind variant folders gets the next suffix, never a shadow.
    let created = store.create("docs/plans", "Roadmap", "three").unwrap();
    assert!(
        created.final_id.as_deref().unwrap().ends_with("/Roadmap-2"),
        "got {:?}",
        created.final_id
    );
}

#[test]
fn rename_never_overwrites_a_case_or_unicode_colliding_destination() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "mine", None).unwrap();
    if store.write("Note", "other", None).is_err() {
        // A case-insensitive filesystem cannot hold both directory entries;
        // rejecting the second identity is the safe outcome there.
        assert_eq!(store.read("note").unwrap(), "mine");
        return;
    }

    let mutation = store.rename("note", "Note").unwrap();
    let final_id = mutation.final_id.clone().unwrap();
    assert_ne!(final_id, "Note");
    assert_eq!(store.read("Note").unwrap(), "other");
    assert_eq!(store.read(&final_id).unwrap(), "mine");
}

// Bootstrap must render the vault even when the search index can't open — a
// search-start failure is a warning, never fatal (A3). Every adapter shares
// this via bootstrap_with_search.
#[test]
fn bootstrap_succeeds_and_seeds_even_when_search_cannot_start() {
    let root = TestRoot::new();
    let store = store(&root);
    let bad_index = root.0.join("index-is-a-file");
    fs::write(&bad_index, "not a directory").unwrap();
    let observer: StatusObserver = Arc::new(|_| {});

    let result = store.bootstrap_with_search(bad_index, observer).unwrap();

    assert_eq!(result.seeded, 1, "empty vault still seeds Welcome");
    assert_eq!(
        result.snapshot.notes.len(),
        1,
        "the note list still populates"
    );
    assert!(
        result.warnings.iter().any(|w| w.contains("search startup")),
        "the search failure is surfaced as a warning"
    );
    assert!(
        store.search("anything", None).unwrap().is_empty(),
        "search degrades to empty, never an error"
    );
}

// B4: if the hard_link install succeeds but dropping the source fails, the
// error path must NOT leave a duplicate (both names live) — the link is undone.
#[cfg(unix)]
#[test]
fn a_failed_source_removal_during_rename_leaves_no_duplicate() {
    use std::os::unix::fs::PermissionsExt;
    let root = TestRoot::new();
    let store = store(&root);
    store.write("Src/note", "the content", None).unwrap();
    let src_dir = root.0.join("Src");
    let original = fs::metadata(&src_dir).unwrap().permissions();
    fs::set_permissions(&src_dir, fs::Permissions::from_mode(0o555)).unwrap();

    // Root ignores DAC, so a read-only dir wouldn't block removal — skip rather
    // than false-pass (probe by trying to write into the now-read-only dir).
    let dac_enforced = fs::write(src_dir.join(".probe"), b"x").is_err();
    if !dac_enforced {
        let _ = fs::remove_file(src_dir.join(".probe"));
        fs::set_permissions(&src_dir, original).unwrap();
        return;
    }

    let result = store.rename("Src/note", "Dst/note");
    fs::set_permissions(&src_dir, original).unwrap();

    assert!(
        result.is_err(),
        "rename must fail when the source can't be removed"
    );
    assert_eq!(
        store.read("Src/note").unwrap(),
        "the content",
        "source note preserved"
    );
    assert!(
        !store.exists("Dst/note"),
        "no stranded duplicate at the destination"
    );
}

#[test]
fn deleting_a_folder_moves_notes_up_with_collisions_before_removing_the_tree() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("A/note", "existing", None).unwrap();
    store.write("A/B/note", "moved", None).unwrap();
    store.write("A/B/C/deep", "deep", None).unwrap();
    store.write("pointer", "[[A/B/note]]", None).unwrap();

    let mutation = store.delete_folder("A/B").unwrap();
    assert_eq!(mutation.renamed.len(), 2);
    assert_eq!(store.read("A/note").unwrap(), "existing");
    assert_eq!(store.read("A/note-2").unwrap(), "moved");
    assert_eq!(store.read("A/C/deep").unwrap(), "deep");
    assert_eq!(store.read("pointer").unwrap(), "[[A/note-2]]");
    assert!(!root.0.join("A/B").exists());
}

#[test]
fn native_folder_delete_preserves_nested_attachments_and_name_collisions() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("A/B/C/note", "body", None).unwrap();
    std::fs::write(root.0.join("A/B/C/photo.png"), b"moved image").unwrap();
    std::fs::create_dir_all(root.0.join("A/C")).unwrap();
    std::fs::write(root.0.join("A/C/photo.png"), b"existing image").unwrap();

    store.delete_folder("A/B").unwrap();

    assert_eq!(store.read("A/C/note").unwrap(), "body");
    assert_eq!(
        std::fs::read(root.0.join("A/C/photo.png")).unwrap(),
        b"existing image"
    );
    assert_eq!(
        std::fs::read(root.0.join("A/C/photo-2.png")).unwrap(),
        b"moved image"
    );
    assert!(!root.0.join("A/B").exists());
}

#[test]
fn native_folder_delete_numbers_a_near_limit_unicode_attachment() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create_folder("A/B").unwrap();
    let name = format!("{}.png", "é".repeat(125));
    std::fs::write(root.0.join("A/B").join(&name), b"moved").unwrap();
    std::fs::write(root.0.join("A").join(&name), b"existing").unwrap();

    store.delete_folder("A/B").unwrap();

    assert_eq!(
        std::fs::read(root.0.join("A").join(&name)).unwrap(),
        b"existing"
    );
    let moved = format!("{}-2.png", "é".repeat(124));
    assert_eq!(
        std::fs::read(root.0.join("A").join(moved)).unwrap(),
        b"moved"
    );
}

#[test]
fn create_folder_and_move_note_rolls_back_the_folder_when_move_fails() {
    let root = TestRoot::new();
    let store = store(&root);

    assert!(store
        .move_note_to_new_folder("missing", "Projects")
        .is_err());
    assert!(
        !root.0.join("Projects").exists(),
        "the failed workflow must not leave an unintended empty folder"
    );
}

#[test]
fn create_folder_and_move_note_commits_both_changes() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "body", None).unwrap();

    let mutation = store.move_note_to_new_folder("note", "Projects").unwrap();

    assert_eq!(mutation.final_id.as_deref(), Some("Projects/note"));
    assert!(root.0.join("Projects").is_dir());
    assert_eq!(store.read("Projects/note").unwrap(), "body");
    assert!(!store.exists("note"));
}

#[test]
fn moving_a_folder_is_one_collision_safe_workflow_and_rewrites_links() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("Projects/Plans/roadmap", "body", None).unwrap();
    store
        .write("Archive/Plans/existing", "occupied", None)
        .unwrap();
    store
        .write("pointer", "[[Projects/Plans/roadmap]]", None)
        .unwrap();

    let mutation = store.move_folder("Projects/Plans", "Archive").unwrap();

    assert_eq!(mutation.final_folder.as_deref(), Some("Archive/Plans-2"));
    assert_eq!(
        mutation.renamed,
        [NoteRename {
            from: "Projects/Plans/roadmap".to_owned(),
            to: "Archive/Plans-2/roadmap".to_owned(),
        }]
    );
    assert_eq!(store.read("Archive/Plans-2/roadmap").unwrap(), "body");
    assert_eq!(
        store.read("pointer").unwrap(),
        "[[Archive/Plans-2/roadmap]]"
    );
    assert!(!root.0.join("Projects/Plans").exists());
}

#[test]
fn moving_a_folder_refuses_itself_or_a_descendant_without_changing_the_vault() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("Projects/Plans/roadmap", "body", None).unwrap();

    for destination in ["Projects", "Projects/Plans", "Projects/Plans/Child"] {
        assert!(
            store.move_folder("Projects", destination).is_err(),
            "accepted destination {destination:?}"
        );
    }

    assert_eq!(store.read("Projects/Plans/roadmap").unwrap(), "body");
    assert_eq!(store.snapshot().folders, ["Projects", "Projects/Plans"]);
}

#[test]
fn destructive_operations_refuse_the_vault_root_and_traversal() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("keep", "body", None).unwrap();
    for unsafe_path in ["", "/", "..", "A/../B", "../outside", "trail/"] {
        assert!(
            store.delete_folder(unsafe_path).is_err(),
            "accepted {unsafe_path:?}"
        );
    }
    assert_eq!(store.read("keep").unwrap(), "body");
    assert!(!root.0.parent().unwrap().join("outside").exists());
}

#[test]
fn mutations_feed_the_same_background_search_owner() {
    let root = TestRoot::new();
    let index = TestRoot::new();
    let store = store(&root);
    store
        .start_search(index.0.clone(), Arc::new(|_| {}))
        .unwrap();
    store.write("pancakes", "milk eggs flour", None).unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let hits = store.search("milk", Some(10)).unwrap();
        if hits.iter().any(|hit| hit.note_id == "pancakes") {
            break;
        }
        assert!(Instant::now() < deadline, "mutation never reached search");
        std::thread::sleep(Duration::from_millis(25));
    }
    store.delete("pancakes").unwrap();
    loop {
        if store.search("milk", Some(10)).unwrap().is_empty() {
            break;
        }
        assert!(Instant::now() < deadline + Duration::from_secs(10));
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn renaming_a_note_removes_the_old_id_from_search_without_a_restart() {
    let root = TestRoot::new();
    let index = TestRoot::new();
    let store = store(&root);
    store
        .start_search(index.0.clone(), Arc::new(|_| {}))
        .unwrap();
    store.write("alpha", "zzqm distinctive body", None).unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let hits = store.search("zzqm", Some(10)).unwrap();
        if hits.iter().any(|hit| hit.note_id == "alpha") {
            break;
        }
        assert!(Instant::now() < deadline, "note never reached search");
        std::thread::sleep(Duration::from_millis(25));
    }

    store.rename("alpha", "beta").unwrap();

    // The rename must drop the stale "alpha" id from the live BM25 index in the
    // same session — no process restart / startup reconcile required.
    loop {
        let hits = store.search("zzqm", Some(10)).unwrap();
        let has_stale = hits.iter().any(|hit| hit.note_id == "alpha");
        let has_new = hits.iter().any(|hit| hit.note_id == "beta");
        if has_new && !has_stale {
            break;
        }
        assert!(
            Instant::now() < deadline + Duration::from_secs(10),
            "rename left the stale old id in search (has_stale={has_stale}, has_new={has_new})"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn mutations_report_the_post_commit_folder_projection() {
    let root = TestRoot::new();
    let store = store(&root);

    let created_folder = store.create_folder("Projects/Empty").unwrap();
    assert_eq!(created_folder.folders, ["Projects", "Projects/Empty"]);

    let created_note = store.create("Projects", "note", "body").unwrap();
    assert_eq!(created_note.folders, ["Projects", "Projects/Empty"]);

    let moved = store.move_note("Projects/note", "Archive").unwrap();
    assert_eq!(moved.folders, ["Archive", "Projects", "Projects/Empty"]);

    let deleted = store.delete("Archive/note").unwrap();
    assert_eq!(deleted.folders, ["Projects", "Projects/Empty"]);

    let deleted_folder = store.delete_folder("Projects").unwrap();
    assert!(deleted_folder.folders.is_empty());
}

// Folder rename once re-resolved every link in the vault against every note id
// for each moved note, then still scanned every note once per moved note. The
// link-rewrite pass must grow with neither again: this moves half the vault.
// Links skip the moved folder, so the timer measures that pass rather than
// fsync'd rewrites.
#[test]
fn folder_rename_in_a_large_linked_vault_is_fast() {
    let root = TestRoot::new();
    let total = 1000;
    for note in 0..total {
        let folder = root.0.join(format!("Folder {}", note % 2));
        fs::create_dir_all(&folder).unwrap();
        let links = (1..=4)
            .map(|step| format!("[[note {}]]", ((note * 7 + step * 13) % total) | 1))
            .collect::<Vec<_>>()
            .join(" ");
        let prose = "Some ordinary words for a realistic body length. ".repeat(40);
        fs::write(folder.join(format!("note {note}.md")), prose + &links).unwrap();
    }
    fs::write(root.0.join("pointer.md"), "[[note 0]]").unwrap();
    let store = store(&root);

    let started = Instant::now();
    let mutation = store.rename_folder("Folder 0", "Renamed").unwrap();
    let elapsed = started.elapsed();

    assert_eq!(mutation.renamed.len(), 500);
    assert_eq!(mutation.relinked, ["pointer"]);
    assert_eq!(store.read("pointer").unwrap(), "[[Renamed/note 0]]");
    assert!(
        elapsed < Duration::from_secs(1),
        "folder rename over {total} linked notes must be fast (was {elapsed:?})"
    );
}

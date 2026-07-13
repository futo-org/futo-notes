use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::*;

struct TestRoot(PathBuf);

impl TestRoot {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "futo-local-note-store-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct RecordingObserver(Mutex<Vec<Vec<FileChange>>>);

impl BeforeWrite for RecordingObserver {
    fn before_write(&self, changes: &[FileChange]) {
        self.0.lock().unwrap().push(changes.to_vec());
    }
}

fn store(root: &TestRoot) -> LocalNoteStore {
    LocalNoteStore::new(root.0.clone())
}

#[test]
fn bootstrap_migrates_txt_collisions_once_before_returning_the_snapshot() {
    let root = TestRoot::new();
    fs::write(root.0.join("note.txt"), "legacy").unwrap();
    fs::write(root.0.join("note.md"), "markdown").unwrap();
    let store = store(&root);

    let result = store.bootstrap().unwrap();
    assert_eq!(result.migrated, 1);
    assert_eq!(result.seeded, 0);
    assert_eq!(store.read("note"), "markdown");
    assert_eq!(store.read("note (imported)"), "legacy");
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
        store.read("Archive/groceries"),
        "self [[Archive/groceries]]"
    );
    assert_eq!(store.read("pointer"), "see [[Archive/groceries]]");
    assert!(!store.exists("Lists/groceries"));
}

#[test]
fn rename_never_overwrites_a_case_or_unicode_colliding_destination() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "mine", None).unwrap();
    if store.write("Note", "other", None).is_err() {
        // A case-insensitive filesystem cannot hold both directory entries;
        // rejecting the second identity is the safe outcome there.
        assert_eq!(store.read("note"), "mine");
        return;
    }

    let mutation = store.rename("note", "Note").unwrap();
    let final_id = mutation.final_id().unwrap();
    assert_ne!(final_id, "Note");
    assert_eq!(store.read("Note"), "other");
    assert_eq!(store.read(final_id), "mine");
}

#[test]
fn conditional_flush_does_not_resurrect_or_overwrite_a_changed_note() {
    let root = TestRoot::new();
    let store = store(&root);
    assert_eq!(
        store
            .write_if_unchanged("missing", "old", "new")
            .unwrap()
            .outcome,
        FlushOutcome::SkippedMissing
    );
    store.write("note", "newer", None).unwrap();
    assert_eq!(
        store
            .write_if_unchanged("note", "stale", "draft")
            .unwrap()
            .outcome,
        FlushOutcome::SkippedChanged
    );
    assert_eq!(store.read("note"), "newer");
    assert_eq!(
        store
            .write_if_unchanged("note", "newer", "draft")
            .unwrap()
            .outcome,
        FlushOutcome::Wrote
    );
    assert_eq!(store.read("note"), "draft");
}

// ── create_if_absent: atomic create-if-absent (PKT-10 round-4 P1a) ──

// A missing note is (re-)created with the draft — the edit-wins peer-delete
// dirty-keep path.
#[test]
fn create_if_absent_creates_when_missing() {
    let root = TestRoot::new();
    let store = store(&root);
    assert_eq!(
        store.create_if_absent("Gone", "recreated-draft").unwrap(),
        CreateOutcome::Created
    );
    assert_eq!(store.read("Gone"), "recreated-draft");
}

// The anti-clobber guarantee: if the id reappeared (a concurrent sync write
// recreated it in the TOCTOU window), the no-replace install fails atomically
// and the newcomer's content is left intact — the caller parks a copy instead.
#[test]
fn create_if_absent_never_clobbers_existing() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("Note", "peer-recreated", None).unwrap();
    assert_eq!(
        store.create_if_absent("Note", "local-draft").unwrap(),
        CreateOutcome::Existed
    );
    assert_eq!(
        store.read("Note"),
        "peer-recreated",
        "a note that reappeared must not be clobbered by the recreate"
    );
}

// Traversal ids are rejected before any fs work (same guard as write).
#[test]
fn create_if_absent_rejects_path_traversal() {
    let root = TestRoot::new();
    let store = store(&root);
    assert!(store.create_if_absent("../escape", "x").is_err());
    assert!(!root.0.parent().unwrap().join("escape.md").exists());
}

// No empty/partial file is ever left behind: the create path installs the
// fully-written content atomically (no `create_new`-then-`write_all` window),
// and BOTH the Created and Existed paths clean up their sibling temp — so no
// `.sf-tmp-*` lingers and the note holds the complete content (not "").
#[test]
fn create_if_absent_leaves_no_temp_or_partial() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create_if_absent("Note", "full-content").unwrap();
    assert_eq!(store.read("Note"), "full-content");
    let stray = |dir: &std::path::Path| {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().starts_with(".sf-tmp-"))
    };
    assert!(!stray(&root.0), "create left a temp file behind");
    assert_eq!(
        store.create_if_absent("Note", "second").unwrap(),
        CreateOutcome::Existed
    );
    assert_eq!(store.read("Note"), "full-content");
    assert!(!stray(&root.0), "existed path left a temp file behind");
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
    assert_eq!(store.read("A/note"), "existing");
    assert_eq!(store.read("A/note-2"), "moved");
    assert_eq!(store.read("A/C/deep"), "deep");
    assert_eq!(store.read("pointer"), "[[A/note-2]]");
    assert!(!root.0.join("A/B").exists());
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
    assert_eq!(store.read("keep"), "body");
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
fn reset_removes_every_vault_entry_but_never_the_vault_directory() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "body", None).unwrap();
    fs::write(root.0.join("image.png"), [1, 2, 3]).unwrap();
    fs::write(root.0.join(".app-state"), "state").unwrap();
    store.reset().unwrap();
    assert!(root.0.is_dir());
    assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
}

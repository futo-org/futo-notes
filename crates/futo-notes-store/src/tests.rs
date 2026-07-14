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

/// Plant a file at the chosen id exactly once, via the install-window hook —
/// simulating a concurrent external/sync writer landing at the id between
/// allocation and the no-replace install.
fn plant_once(root: &TestRoot, content: &'static str) -> Box<dyn Fn(&str) + Send + Sync> {
    let dir = root.0.clone();
    let planted = Mutex::new(false);
    Box::new(move |id: &str| {
        let mut done = planted.lock().unwrap();
        if !*done {
            fs::write(dir.join(format!("{id}.md")), content).unwrap();
            *done = true;
        }
    })
}

// A create whose chosen id is taken by a concurrent writer in the
// allocate→install window must NOT overwrite that writer's file — it re-suffixes
// and both contents survive (A1).
#[test]
fn create_never_clobbers_a_concurrent_writer_at_the_chosen_id() {
    let root = TestRoot::new();
    let store = store(&root);
    store.set_install_window_hook(plant_once(&root, "peer wrote here"));

    let mutation = store.create("", "Note", "my new note").unwrap();
    let final_id = mutation.final_id().unwrap();

    assert_ne!(final_id, "Note", "create must re-suffix away from the taken id");
    assert_eq!(
        store.read("Note"),
        "peer wrote here",
        "the concurrent writer's file must not be clobbered"
    );
    assert_eq!(store.read(final_id), "my new note");
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

    assert_eq!(store.read("Welcome"), "installed", "live note untouched");
    let recovered: Vec<_> = store
        .snapshot()
        .notes
        .into_iter()
        .filter(|note| note.id.contains("recovered"))
        .collect();
    assert_eq!(recovered.len(), 1, "the divergent backup surfaced as a visible note");
    assert_eq!(store.read(&recovered[0].id), "old superseded");
    assert!(!root.0.join(".sf-bak-1-1-1").exists(), "backup renamed into the recovered note");
    assert!(!root.0.join(".sf-bak-1-1-1.path").exists(), "sidecar consumed");

    // The user deletes the live note; a later bootstrap must NOT resurrect it.
    store.delete("Welcome").unwrap();
    store.bootstrap().unwrap();
    assert!(!store.exists("Welcome"), "a deleted note must not be resurrected");
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

    assert_eq!(store.read("Welcome"), "live", "live note untouched");
    // The planted note at the first-chosen recovered name is intact...
    assert_eq!(
        store.read("Welcome (recovered)"),
        "peer at recovered name",
        "the concurrent writer at the recovered name must not be clobbered"
    );
    // ...and the recovered content re-suffixed to the next name.
    assert_eq!(store.read("Welcome (recovered)-2"), "stranded");
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
    assert_eq!(recovered.len(), 1, "re-sweep must not duplicate the recovered note");
    assert_eq!(store.read("Welcome (recovered)"), "old superseded");
    assert!(!root.0.join(".sf-bak-1-1-1").exists(), "backup cleaned up");
    assert!(!root.0.join(".sf-bak-1-1-1.path").exists(), "sidecar cleaned up");
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
    assert_eq!(recovered[0].folder, "Projects", "recovered note stays in its folder");
    assert!(recovered[0].id.starts_with("Projects/"));
    assert_eq!(store.read(&recovered[0].id), "stranded");
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
    assert_eq!(result.snapshot.notes.len(), 1, "the note list still populates");
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

    assert!(result.is_err(), "rename must fail when the source can't be removed");
    assert_eq!(store.read("Src/note"), "the content", "source note preserved");
    assert!(!store.exists("Dst/note"), "no stranded duplicate at the destination");
}

// ── search-engine start self-heal (F13 retry, PKT-10, now shared) ──

// A failed engine start degrades (never crashes) and is retried lazily on a
// later call — but only after the cooldown, so a persistent failure is not
// reopened on every call. Uses the cheapest real seam: an index dir that is a
// regular file (TantivyIndices::open's create_dir_all fails), cleared between
// attempts so the retry can succeed.
#[test]
fn search_engine_start_failure_self_heals_after_cooldown() {
    let root = TestRoot::new();
    let store = store(&root);

    let index_path = root.0.join("blocking-index");
    fs::write(&index_path, "not a directory").unwrap();
    let observer: StatusObserver = Arc::new(|_| {});

    // Degraded, not crashed: start returns Err, search stays usable (empty).
    assert!(store.start_search(index_path.clone(), observer).is_err());
    assert!(!store.search_engine_installed());
    assert!(store.search("anything", None).unwrap().is_empty());

    // Cause cleared, but still WITHIN the cooldown → no re-attempt yet.
    fs::remove_file(&index_path).unwrap();
    assert!(store.search("anything", None).unwrap().is_empty());
    assert!(
        !store.search_engine_installed(),
        "must not re-attempt the start within the cooldown"
    );

    // Cooldown elapsed → the next call retries and, the cause now gone, starts.
    store.expire_search_retry_cooldown();
    let _ = store.search("anything", None);
    assert!(
        store.search_engine_installed(),
        "must retry and start once the cooldown elapses"
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

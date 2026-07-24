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
    let final_id = mutation.final_id.clone().unwrap();

    assert_ne!(final_id, "Note", "create must re-suffix away from the taken id");
    assert_eq!(
        store.read("Note"),
        "peer wrote here",
        "the concurrent writer's file must not be clobbered"
    );
    assert_eq!(store.read(&final_id), "my new note");
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
        store.read("Welcome (recovered)"),
        "stranded",
        "the backup must still be parked as a NEW recovered note"
    );
    assert_eq!(
        store.read("Welcome (recovered) draft"),
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
    let final_id = mutation.final_id.clone().unwrap();
    assert_ne!(final_id, "Note");
    assert_eq!(store.read("Note"), "other");
    assert_eq!(store.read(&final_id), "mine");
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
fn wait_until_search_ready_returns_false_once_the_budget_elapses() {
    let root = TestRoot::new();
    let store = store(&root);

    let started = Instant::now();
    assert!(!store.wait_until_search_ready(80));
    let waited = started.elapsed();
    assert!(waited >= Duration::from_millis(80), "returned before the budget: {waited:?}");
    assert!(waited < Duration::from_secs(5), "wait unbounded: {waited:?}");
}

#[test]
fn wait_until_search_ready_reports_readiness_of_a_real_engine() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "indexable body", None).unwrap();
    let observer: StatusObserver = Arc::new(|_| {});
    store
        .bootstrap_with_search(root.0.join("index"), observer)
        .unwrap();

    assert!(
        store.wait_until_search_ready(10_000),
        "keyword index never became ready"
    );
    assert!(store.search_status().keyword.ready);
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

    let mutation = store
        .move_note_to_new_folder("note", "Projects")
        .unwrap();

    assert_eq!(mutation.final_id.as_deref(), Some("Projects/note"));
    assert!(root.0.join("Projects").is_dir());
    assert_eq!(store.read("Projects/note"), "body");
    assert!(!store.exists("note"));
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

fn ids_in_order(store: &LocalNoteStore) -> Vec<String> {
    store
        .snapshot()
        .notes
        .into_iter()
        .map(|note| note.id)
        .collect()
}

fn apply_as_shell(list: &[String], mutation: &MutationResult) -> Vec<String> {
    let affected: HashSet<&str> = mutation
        .removed
        .iter()
        .map(String::as_str)
        .chain(mutation.upserted.iter().map(|entry| entry.note.id.as_str()))
        .collect();
    let mut next: Vec<String> = list
        .iter()
        .filter(|id| !affected.contains(id.as_str()))
        .cloned()
        .collect();
    for entry in &mutation.upserted {
        let position = (entry.position as usize).min(next.len());
        next.insert(position, entry.note.id.clone());
    }
    next
}

#[test]
fn the_note_list_orders_most_recently_modified_first_with_id_tiebreak() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("z", "", Some(5_000)).unwrap();
    store.write("a", "", Some(5_000)).unwrap();
    store.write("m", "", Some(5_000)).unwrap();
    store.write("old", "", Some(1_000)).unwrap();
    store.write("new", "", Some(9_000)).unwrap();
    assert_eq!(ids_in_order(&store), ["new", "a", "m", "z", "old"]);
}

// UTF-8 orders U+FDFD before U+1F600, opposite native UTF-16 comparison.
// The browser twin pins the same surrogate-range fixture.
#[test]
fn the_id_tiebreak_compares_utf8_bytes_across_the_surrogate_range() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("\u{1F600}", "", Some(5_000)).unwrap();
    store.write("\u{FDFD}", "", Some(5_000)).unwrap();
    assert_eq!(ids_in_order(&store), ["\u{FDFD}", "\u{1F600}"]);
}

#[test]
fn upserted_positions_index_into_the_post_mutation_sorted_snapshot() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("a", "1", Some(1_000)).unwrap();
    store.write("b", "2", Some(2_000)).unwrap();
    store.write("c", "3", Some(3_000)).unwrap();

    let edited = store.write("a", "1 edited", Some(4_000)).unwrap();
    assert_eq!(edited.final_id.as_deref(), Some("a"));
    assert_eq!(edited.upserted.len(), 1);
    assert_eq!(edited.upserted[0].position, 0);

    let mid = store.write("d", "4", Some(2_500)).unwrap();
    assert_eq!(mid.upserted[0].position, 2);
    assert_eq!(ids_in_order(&store), ["a", "c", "d", "b"]);
}

#[test]
fn applying_removals_then_position_splices_reproduces_the_snapshot_order() {
    let root = TestRoot::new();
    let store = store(&root);
    store
        .write("Lists/groceries", "self [[groceries]]", Some(1_000))
        .unwrap();
    store.write("pointer", "see [[groceries]]", Some(2_000)).unwrap();
    store.write("third", "unrelated", Some(3_000)).unwrap();

    let before = ids_in_order(&store);
    let renamed = store.rename("Lists/groceries", "Archive/groceries").unwrap();
    assert_eq!(apply_as_shell(&before, &renamed), ids_in_order(&store));

    let before = ids_in_order(&store);
    let folder_deleted = store.delete_folder("Archive").unwrap();
    assert_eq!(apply_as_shell(&before, &folder_deleted), ids_in_order(&store));

    let before = ids_in_order(&store);
    let deleted = store.delete("pointer").unwrap();
    assert_eq!(apply_as_shell(&before, &deleted), ids_in_order(&store));
}

#[test]
fn mutations_report_the_primary_notes_final_id() {
    let root = TestRoot::new();
    let store = store(&root);
    let created = store.create("", "Note", "one").unwrap();
    assert_eq!(created.final_id.as_deref(), Some("Note"));

    let collided = store.create("", "Note", "two").unwrap();
    assert_eq!(collided.final_id.as_deref(), Some("Note-2"));

    let written = store.write("Note", "three", None).unwrap();
    assert_eq!(written.final_id.as_deref(), Some("Note"));

    let renamed = store.rename("Note-2", "Renamed").unwrap();
    assert_eq!(renamed.final_id.as_deref(), Some("Renamed"));

    assert_eq!(store.delete("Renamed").unwrap().final_id, None);
    store.write("F/x", "", None).unwrap();
    assert_eq!(store.rename_folder("F", "G").unwrap().final_id, None);
    assert_eq!(store.delete_folder("G").unwrap().final_id, None);
}

// ── flush_draft: the one draft-saving verb (persist-or-park, issue #37) ──
// The composition (conditional write / converge / recreate / park) runs under
// the store's mutation gate, and every install stays no-replace against
// writers outside that serialization. iOS's flushAsync state machine is the
// behavioral contract these tests pin.

#[test]
fn flush_draft_writes_when_the_note_still_holds_the_base() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "base text", None).unwrap();

    let result = store.flush_draft("note", "base text", "draft text").unwrap();

    assert_eq!(result.disposition, FlushDisposition::Wrote);
    let mutation = result.mutation.expect("a write projects a mutation");
    assert_eq!(mutation.final_id.as_deref(), Some("note"));
    assert_eq!(mutation.upserted[0].note.id, "note");
    assert_eq!(store.read("note"), "draft text");
}

// The converged/park boundary: disk already holding the draft is an explicit
// outcome (shells never read disk to compare), and it must not rewrite
// identical bytes — an mtime bump would re-rank the note on every device.
#[test]
fn flush_draft_reports_convergence_without_rewriting_identical_bytes() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "same text", Some(1_000)).unwrap();

    let result = store.flush_draft("note", "stale base", "same text").unwrap();

    assert_eq!(result.disposition, FlushDisposition::Converged);
    assert!(result.mutation.is_none());
    let note = &store.snapshot().notes[0];
    assert_eq!(note.modified_ms, 1_000, "converged must not bump mtime");
    assert_eq!(store.snapshot().notes.len(), 1, "no conflict copy minted");
}

#[test]
fn flush_draft_parks_a_diverged_draft_as_a_dated_conflict_copy() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "peer version", None).unwrap();

    let result = store.flush_draft("note", "original base", "my draft").unwrap();

    let expected_copy = format!("note (conflict {})", current_conflict_date());
    assert_eq!(
        result.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: expected_copy.clone()
        }
    );
    let mutation = result.mutation.expect("a fresh park projects a mutation");
    assert_eq!(mutation.final_id.as_deref(), Some(expected_copy.as_str()));
    assert_eq!(mutation.upserted[0].note.id, expected_copy);
    assert_eq!(store.read("note"), "peer version", "diverged note untouched");
    assert_eq!(store.read(&expected_copy), "my draft");
}

#[test]
fn flush_draft_recreates_a_peer_deleted_note_at_the_original_id() {
    let root = TestRoot::new();
    let store = store(&root);

    let result = store.flush_draft("Gone", "old base", "surviving draft").unwrap();

    assert_eq!(result.disposition, FlushDisposition::Recreated);
    assert_eq!(store.read("Gone"), "surviving draft");
    let mutation = result.mutation.expect("a recreate projects a mutation");
    assert_eq!(mutation.final_id.as_deref(), Some("Gone"));
    assert_eq!(mutation.upserted[0].note.id, "Gone");
}

// The recreate arm returns a proper POSITIONED mutation (issue #35 contract) —
// the shell full-reload workaround is gone, so a splice-apply must reproduce
// the engine's order.
#[test]
fn the_recreate_arm_returns_a_positioned_mutation() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("a", "1", Some(1_000)).unwrap();
    store.write("b", "2", Some(2_000)).unwrap();
    let before = ids_in_order(&store);

    let result = store.flush_draft("Gone", "old", "draft").unwrap();

    assert_eq!(result.disposition, FlushDisposition::Recreated);
    let mutation = result.mutation.unwrap();
    assert_eq!(
        mutation.upserted[0].position, 0,
        "the freshly recreated note ranks newest"
    );
    assert_eq!(apply_as_shell(&before, &mutation), ids_in_order(&store));
}

// The recreate-vs-reappeared window: a live-sync pull recreating the id
// between the missing-read and the install must not be clobbered — the draft
// is parked instead.
#[test]
fn flush_draft_parks_when_the_id_reappears_inside_the_recreate_window() {
    let root = TestRoot::new();
    let store = store(&root);
    store.set_install_window_hook(plant_once(&root, "peer recreated"));

    let result = store.flush_draft("Gone", "old base", "my draft").unwrap();

    let expected_copy = format!("Gone (conflict {})", current_conflict_date());
    assert_eq!(
        result.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: expected_copy.clone()
        }
    );
    assert_eq!(
        store.read("Gone"),
        "peer recreated",
        "the reappeared note must not be clobbered"
    );
    assert_eq!(store.read(&expected_copy), "my draft");
}

#[test]
fn flush_draft_converges_when_the_reappeared_id_already_holds_the_draft() {
    let root = TestRoot::new();
    let store = store(&root);
    store.set_install_window_hook(plant_once(&root, "my draft"));

    let result = store.flush_draft("Gone", "old base", "my draft").unwrap();

    assert_eq!(result.disposition, FlushDisposition::Converged);
    assert!(result.mutation.is_none());
    assert_eq!(store.snapshot().notes.len(), 1, "no conflict copy minted");
}

// Park idempotency (the crash-window double-park, e.g. a scenePhase flush
// firing at both .inactive and .background): an identical draft parked twice
// mints ONE copy, and the second park still reports where it lives.
#[test]
fn parking_an_identical_draft_twice_mints_one_copy() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "peer version", None).unwrap();

    let first = store.flush_draft("note", "original", "my draft").unwrap();
    let second = store.flush_draft("note", "original", "my draft").unwrap();

    let expected_copy = format!("note (conflict {})", current_conflict_date());
    assert_eq!(
        first.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: expected_copy.clone()
        }
    );
    assert_eq!(
        second.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: expected_copy
        }
    );
    assert!(second.mutation.is_none(), "the second park must mint nothing");
    assert_eq!(store.snapshot().notes.len(), 2, "original + exactly one copy");
}

// A genuinely different second draft is NOT the idempotent case — it gets its
// own copy through the naming rule's counter ("<stem> 2"), never a clobber of
// the first copy.
#[test]
fn each_distinct_diverged_draft_gets_its_own_counter_suffixed_copy() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "peer version", None).unwrap();

    store.flush_draft("note", "original", "draft one").unwrap();
    let second = store.flush_draft("note", "original", "draft two").unwrap();

    let date = current_conflict_date();
    assert_eq!(
        second.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: format!("note (conflict {date} 2)")
        }
    );
    assert_eq!(store.read(&format!("note (conflict {date})")), "draft one");
    assert_eq!(store.read(&format!("note (conflict {date} 2)")), "draft two");
}

// The idempotency guard matches only names this park could have minted — a
// similarly-named user note holding the same content must not swallow the
// park (the F1 class the recovered-backup guard already pins).
#[test]
fn the_park_guard_ignores_a_similarly_named_note_with_identical_content() {
    let root = TestRoot::new();
    let store = store(&root);
    let date = current_conflict_date();
    store.write("note", "peer version", None).unwrap();
    store
        .write(&format!("note (conflict {date}) draft"), "my draft", None)
        .unwrap();

    let result = store.flush_draft("note", "original", "my draft").unwrap();

    assert_eq!(
        result.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: format!("note (conflict {date})")
        }
    );
    assert_eq!(store.read(&format!("note (conflict {date})")), "my draft");
}

// The engine's naming rule peels an existing conflict suffix instead of
// stacking a second one — parking a conflict copy yields a fresh dated copy.
#[test]
fn parking_a_conflict_copy_does_not_stack_suffixes() {
    let root = TestRoot::new();
    let store = store(&root);
    store
        .write("note (conflict 2026-01-01)", "peer version", None)
        .unwrap();

    let result = store
        .flush_draft("note (conflict 2026-01-01)", "original", "my draft")
        .unwrap();

    assert_eq!(
        result.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: format!("note (conflict {})", current_conflict_date())
        }
    );
}

// F4: the recreate arm must never install an id that cross-platform-collides
// (case-insensitive / NFC) with a DIFFERENT surviving note. `create_new_atomic`
// only catches an EXACT-path collision, so on a case-sensitive filesystem a
// peer-deleted draft at "Note" could otherwise shadow a live "note". The arm
// parks the draft at a non-shadowing id instead. (On a case-INSENSITIVE FS the
// two ids are one file: the missing-read never fires and the diverged arm parks
// anyway — so both filesystems land on ParkedConflict with no shadow.)
#[test]
fn flush_draft_recreate_parks_instead_of_shadowing_a_case_colliding_note() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "surviving peer", None).unwrap();

    let result = store.flush_draft("Note", "old base", "my draft").unwrap();

    let parked_id = match result.disposition {
        FlushDisposition::ParkedConflict { parked_id } => parked_id,
        other => panic!("expected the draft parked, not a shadow install: {other:?}"),
    };
    assert_eq!(
        store.read("note"),
        "surviving peer",
        "the case-colliding sibling must be untouched"
    );
    assert_eq!(
        store.read(&parked_id),
        "my draft",
        "the draft survives as a non-shadowing conflict copy"
    );
}

// F4: the park mint loop must skip a candidate id that cross-platform-collides
// with a DIFFERENT live note. The first dated candidate "note (conflict DATE)"
// collides (case-only) with an existing "Note (conflict DATE)"; the loop must
// advance to the next counter variant rather than install a shadow that
// `create_new_atomic` can't detect on a case-sensitive filesystem.
#[test]
fn flush_draft_park_skips_a_case_colliding_conflict_id() {
    let root = TestRoot::new();
    let store = store(&root);
    let date = current_conflict_date();
    store.write("note", "peer version", None).unwrap();
    store
        .write(&format!("Note (conflict {date})"), "unrelated copy", None)
        .unwrap();

    let result = store.flush_draft("note", "original base", "my draft").unwrap();

    let parked_id = match result.disposition {
        FlushDisposition::ParkedConflict { parked_id } => parked_id,
        other => panic!("expected a parked conflict copy: {other:?}"),
    };
    assert_eq!(
        parked_id,
        format!("note (conflict {date} 2)"),
        "the park must skip the case-colliding first candidate, not shadow it"
    );
    assert_eq!(store.read(&parked_id), "my draft");
    assert_eq!(
        store.read(&format!("Note (conflict {date})")),
        "unrelated copy",
        "the case-colliding sibling must be untouched"
    );
}

#[test]
fn flush_draft_parks_inside_the_notes_folder() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("Projects/note", "peer version", None).unwrap();

    let result = store
        .flush_draft("Projects/note", "original", "my draft")
        .unwrap();

    let expected_copy = format!("Projects/note (conflict {})", current_conflict_date());
    assert_eq!(
        result.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: expected_copy.clone()
        }
    );
    assert_eq!(store.read(&expected_copy), "my draft");
}

// A writer outside the store's serialization landing on the chosen copy name
// inside the park window fails the no-replace install; the retry re-runs the
// naming rule and both contents survive (the A1 window applied to parks).
#[test]
fn flush_draft_never_clobbers_a_concurrent_writer_at_the_parked_name() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "peer version", None).unwrap();
    store.set_install_window_hook(plant_once(&root, "peer at copy name"));

    let result = store.flush_draft("note", "original", "my draft").unwrap();

    let date = current_conflict_date();
    assert_eq!(
        result.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: format!("note (conflict {date} 2)")
        }
    );
    assert_eq!(
        store.read(&format!("note (conflict {date})")),
        "peer at copy name",
        "the concurrent writer's copy must not be clobbered"
    );
    assert_eq!(store.read(&format!("note (conflict {date} 2)")), "my draft");
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

#[test]
fn vault_migration_copies_every_entry_and_deletes_source_only_after_finalize() {
    let source = TestRoot::new();
    let destination = TestRoot::new();
    let store = store(&source);
    store.write("Folder/note", "body", None).unwrap();
    fs::write(source.0.join("image.png"), [1, 2, 3]).unwrap();
    fs::write(source.0.join(".e2ee-state.json"), "checkpoint").unwrap();

    let outcome = store.stage_vault_migration(&destination.0).unwrap();

    assert_eq!(outcome.status, VaultMigrationStatus::Migrated);
    assert_eq!(
        fs::read_to_string(destination.0.join("Folder/note.md")).unwrap(),
        "body"
    );
    assert_eq!(
        fs::read(destination.0.join("image.png")).unwrap(),
        [1, 2, 3]
    );
    assert_eq!(
        fs::read_to_string(destination.0.join(".e2ee-state.json")).unwrap(),
        "checkpoint"
    );
    assert!(source.0.join("Folder/note.md").exists());

    assert_eq!(
        store
            .finalize_vault_migration(&destination.0, true)
            .unwrap(),
        VaultMigrationFinalization::Finalized
    );
    assert!(!source.0.exists());
}

#[test]
fn vault_migration_refuses_a_different_destination_without_changing_either_vault() {
    let source = TestRoot::new();
    let destination = TestRoot::new();
    let store = store(&source);
    store.write("note", "source", None).unwrap();
    fs::write(destination.0.join("note.md"), "destination").unwrap();

    assert!(store.stage_vault_migration(&destination.0).is_err());

    assert_eq!(store.read("note"), "source");
    assert_eq!(
        fs::read_to_string(destination.0.join("note.md")).unwrap(),
        "destination"
    );
}

#[test]
fn vault_migration_finalize_refuses_to_delete_a_changed_source() {
    let source = TestRoot::new();
    let destination = TestRoot::new();
    let store = store(&source);
    store.write("note", "source", None).unwrap();
    store.stage_vault_migration(&destination.0).unwrap();
    store.write("late", "new edit", None).unwrap();

    assert_eq!(
        store
            .finalize_vault_migration(&destination.0, true)
            .unwrap(),
        VaultMigrationFinalization::DestinationChanged
    );
    assert!(source.0.exists());
    assert_eq!(store.read("late"), "new edit");
}

#[test]
fn vault_migration_retains_a_shared_source_that_external_writers_can_reach() {
    let source = TestRoot::new();
    let destination = TestRoot::new();
    let store = store(&source);
    store.write("note", "source", None).unwrap();
    store.stage_vault_migration(&destination.0).unwrap();

    assert_eq!(
        store
            .finalize_vault_migration(&destination.0, false)
            .unwrap(),
        VaultMigrationFinalization::SourceRetained
    );
    assert_eq!(store.read("note"), "source");
}

#[test]
fn vault_migration_retains_an_empty_shared_source() {
    let source = TestRoot::new();
    let destination = source.0.with_extension("new-shared-location");
    let store = store(&source);

    let outcome = store.stage_vault_migration(&destination).unwrap();

    assert_eq!(outcome.status, VaultMigrationStatus::EmptySource);
    assert_eq!(
        store
            .finalize_vault_migration(&destination, false)
            .unwrap(),
        VaultMigrationFinalization::SourceRetained
    );
    assert!(source.0.is_dir());
}

#[test]
fn empty_vault_migration_does_not_require_a_destination_to_finalize() {
    let source = TestRoot::new();
    let destination = source.0.with_extension("new-location");
    let store = store(&source);

    let outcome = store.stage_vault_migration(&destination).unwrap();

    assert_eq!(outcome.status, VaultMigrationStatus::EmptySource);
    assert!(!destination.exists());
    assert_eq!(
        store
            .finalize_vault_migration(&destination, true)
            .unwrap(),
        VaultMigrationFinalization::Finalized
    );
    assert!(!source.0.exists());
}

#[test]
fn empty_vault_migration_refuses_an_unrelated_nonempty_destination() {
    let source = TestRoot::new();
    let destination = TestRoot::new();
    let store = store(&source);
    fs::write(destination.0.join("unrelated.md"), "keep me").unwrap();

    assert!(store.stage_vault_migration(&destination.0).is_err());

    assert!(source.0.exists());
    assert_eq!(
        fs::read_to_string(destination.0.join("unrelated.md")).unwrap(),
        "keep me"
    );
}

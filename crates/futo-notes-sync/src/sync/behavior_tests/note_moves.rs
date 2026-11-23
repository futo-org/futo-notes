//! Every relocation a pull makes reports the move (`futo_notes_core::files::
//! note_moved`) while it still holds the vault guard, once its target holds
//! the note, so a note store's editor attached to the note follows it before
//! any save of it lands (the store side: futo-notes-store
//! `tests/editor_session/relocation.rs`). Reported only as a summary rename, it
//! was followed after the cycle, and a save in between recreated the old id: a
//! ghost that synced to every peer.
//!
//! A pulled move renames the note, moves its mapping, then fast-forwards the
//! content, so a failure at any step leaves one mapped name holding the note.
//! Written to the target first, a move that then failed left the push an
//! unmapped duplicate to create, or a mapped name missing from disk to delete.
use super::*;
use crate::checkpoint::Ancestry;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

/// (root, from, to, reported under the vault guard with `to` on disk).
type Move = (PathBuf, String, String, bool);
static MOVES: Mutex<Vec<Move>> = Mutex::new(Vec::new());

fn record(root: &Path, from: &str, to: &str) {
    // Held: another thread cannot take the guard while the report runs.
    let (taken, guard_free) = mpsc::channel();
    std::thread::spawn(move || {
        let _vault = futo_notes_core::files::vault_mutation_guard();
        let _ = taken.send(());
    });
    let held = guard_free.recv_timeout(Duration::from_millis(50)).is_err();
    let ready = held && root.join(to).is_file();
    let entry = (root.to_owned(), from.to_owned(), to.to_owned(), ready);
    MOVES.lock().unwrap().push(entry);
}

fn moves_in(root: &TempRoot) -> Vec<(String, String, bool)> {
    futo_notes_core::files::on_note_moved(record);
    MOVES
        .lock()
        .unwrap()
        .iter()
        .filter(|(at, ..)| at == root.path())
        .map(|(_, from, to, held)| (from.clone(), to.clone(), *held))
        .collect()
}

fn pull(state: &mut ConnectedState, root: &TempRoot, note: &RemoteNote) -> SyncSummary {
    futo_notes_core::files::on_note_moved(record);
    let mut summary = SyncSummary::default();
    apply_remote(
        state,
        root.path(),
        note,
        &HashMap::new(),
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();
    summary
}

#[test]
fn a_pulled_rename_reports_the_move_under_the_guard() {
    let root = TempRoot::new();
    let mut state = connected();
    std::fs::write(root.path().join("old.md"), "body").unwrap();
    state
        .object_map
        .insert("old.md".into(), entry("object", Some(&hash_sha256("body"))));

    pull(&mut state, &root, &remote("object", "new.md", "body"));

    assert_eq!(moves_in(&root), [("old.md".into(), "new.md".into(), true)]);
    assert!(!root.path().join("old.md").exists());
}

// A read-only folder is how a test fails a write; no Windows equivalent here.
#[cfg(unix)]
#[test]
fn a_pulled_rename_whose_target_cannot_be_written_keeps_the_old_note() {
    let root = TempRoot::new();
    let mut state = connected();
    std::fs::write(root.path().join("old.md"), "body").unwrap();
    state
        .object_map
        .insert("old.md".into(), entry("object", Some(&hash_sha256("body"))));
    // The target's folder refuses writes.
    let folder = root.path().join("locked");
    std::fs::create_dir(&folder).unwrap();
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();

    futo_notes_core::files::on_note_moved(record);
    let mut summary = SyncSummary::default();
    let pulled = apply_remote(
        &mut state,
        root.path(),
        &remote("object", "locked/new.md", "edited"),
        &HashMap::new(),
        false,
        &no_pre,
        &mut summary,
    );

    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(pulled.is_err());
    assert_eq!(
        std::fs::read_to_string(root.path().join("old.md")).unwrap(),
        "body"
    );
    assert!(moves_in(&root).is_empty());
    // Still the mapped object: unmapped, the next push uploaded it as a new
    // note on every device. Nothing about the move is reported yet.
    assert!(state.object_map.contains_key("old.md"));
    assert!(summary.renamed.is_empty() && summary.deleted_ids.is_empty());
}

fn mapped(state: &ConnectedState) -> Vec<String> {
    let mut names: Vec<_> = state.object_map.keys().cloned().collect();
    names.sort();
    names
}

/// What the next push plans from this state: it deletes a mapped name missing
/// from disk and uploads a file that is unmapped or holds other bytes than its
/// mapping. Asserts it would do neither.
fn assert_push_plans_nothing(state: &ConnectedState, root: &TempRoot) {
    let files = local_files(root.path()).unwrap();
    let missing = crate::sync::push::local_changes::missing_local_files(state, &files);
    assert!(missing.is_empty(), "the push would delete {missing:?}");
    for file in files {
        let mapped = state.object_map.get(&file.name).map(|entry| &entry.hash);
        let held = Some(hash_sha256(&read_content(root.path(), &file.name).unwrap()));
        assert_eq!(mapped, Some(&held), "the push would upload {}", file.name);
    }
}

/// A `pre_write` that turns `dest/` read-only once `dest/new.md` is on disk:
/// the rename into it lands, the content write after it fails.
#[cfg(unix)]
fn lock_once_moved(root: &TempRoot) -> impl Fn(&str) + Send + Sync {
    let folder = root.path().join("dest");
    move |name: &str| {
        if name == "dest/new.md" && folder.join("new.md").is_file() {
            std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();
        }
    }
}

#[cfg(unix)]
fn unlock(root: &TempRoot) {
    let folder = root.path().join("dest");
    std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o755)).unwrap();
}

// A read-only folder is how a test refuses a rename; no Windows equivalent here.
#[cfg(unix)]
#[test]
fn a_pulled_rename_its_folder_refuses_changes_nothing() {
    let root = TempRoot::new();
    let mut state = connected();
    let folder = root.path().join("ro");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(folder.join("old.md"), "body").unwrap();
    let mapping = entry("object", Some(&hash_sha256("body")));
    state.object_map.insert("ro/old.md".into(), mapping.clone());
    let note = remote("object", "new.md", "edited");

    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();
    let mut summary = SyncSummary::default();
    let failed = apply_remote(
        &mut state,
        root.path(),
        &note,
        &HashMap::new(),
        false,
        &no_pre,
        &mut summary,
    );
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert!(failed.is_err());
    assert_eq!(read_content(root.path(), "ro/old.md").unwrap(), "body");
    assert!(!root.path().join("new.md").exists());
    assert_eq!(state.object_map["ro/old.md"], mapping);
    assert_eq!(mapped(&state), ["ro/old.md"]);
    assert_eq!(
        format!("{summary:?}"),
        format!("{:?}", SyncSummary::default())
    );
    assert!(moves_in(&root).is_empty());

    pull(&mut state, &root, &note);
    assert_eq!(mapped(&state), ["new.md"]);
    assert_eq!(read_content(root.path(), "new.md").unwrap(), "edited");
}

/// The rename lands, then the content write fails (the target's folder turns
/// read-only): the target holds the previous version under the object's only
/// mapping, so the push has nothing to do and the next pull updates it.
#[cfg(unix)]
#[test]
fn a_pulled_rename_whose_write_fails_leaves_the_moved_note_mapped() {
    let root = TempRoot::new();
    let mut state = connected();
    std::fs::write(root.path().join("old.md"), "body").unwrap();
    let mapping = entry("object", Some(&hash_sha256("body")));
    state.object_map.insert("old.md".into(), mapping.clone());
    let mut note = remote("object", "dest/new.md", "edited");
    note.object.version = 2;

    let mut summary = SyncSummary::default();
    let failed = apply_remote(
        &mut state,
        root.path(),
        &note,
        &HashMap::new(),
        false,
        &lock_once_moved(&root),
        &mut summary,
    );
    unlock(&root);

    assert!(failed.is_err());
    assert!(!root.path().join("old.md").exists());
    assert_eq!(read_content(root.path(), "dest/new.md").unwrap(), "body");
    assert_eq!(state.object_map["dest/new.md"], mapping);
    assert_eq!(mapped(&state), ["dest/new.md"]);
    assert_push_plans_nothing(&state, &root);
    // The rename happened, so the summary says so.
    assert_eq!(summary.renamed.len(), 1);

    pull(&mut state, &root, &note);
    assert_eq!(read_content(root.path(), "dest/new.md").unwrap(), "edited");
}

/// First sync: the moved note is unmapped, holding its ancestry's bytes. The
/// same rename-then-write, so a failed write leaves it mapped, not a duplicate
/// for the push to create.
#[cfg(unix)]
#[test]
fn a_first_sync_rename_whose_write_fails_leaves_the_moved_note_mapped() {
    let root = TempRoot::new();
    let mut state = connected();
    std::fs::write(root.path().join("old.md"), "body").unwrap();
    let ancestor = Ancestry {
        object_id: "object".into(),
        hash: hash_sha256("body"),
    };
    let ancestry = HashMap::from([("old.md".to_owned(), ancestor)]);
    let note = remote("object", "dest/new.md", "edited");

    let failed = apply_remote(
        &mut state,
        root.path(),
        &note,
        &ancestry,
        true,
        &lock_once_moved(&root),
        &mut SyncSummary::default(),
    );
    unlock(&root);

    assert!(failed.is_err());
    assert_eq!(read_content(root.path(), "dest/new.md").unwrap(), "body");
    assert_eq!(mapped(&state), ["dest/new.md"]);
    assert_push_plans_nothing(&state, &root);

    pull(&mut state, &root, &note);
    assert_eq!(read_content(root.path(), "dest/new.md").unwrap(), "edited");
}

/// An attached editor's save that lands between the rename and the content
/// write is kept: the write refuses, and the next cycle meets an ordinary local
/// edit against the remote one.
#[test]
fn a_save_between_a_pulled_rename_and_its_write_is_not_overwritten() {
    let root = TempRoot::new();
    let mut state = connected();
    std::fs::write(root.path().join("old.md"), "body").unwrap();
    let mapping = entry("object", Some(&hash_sha256("body")));
    state.object_map.insert("old.md".into(), mapping.clone());
    let target = root.path().join("new.md");
    let save_after_rename = {
        let target = target.clone();
        move |name: &str| {
            if name == "new.md" && target.is_file() {
                std::fs::write(&target, "draft").unwrap();
            }
        }
    };

    let failed = apply_remote(
        &mut state,
        root.path(),
        &remote("object", "new.md", "edited"),
        &HashMap::new(),
        false,
        &save_after_rename,
        &mut SyncSummary::default(),
    );

    assert!(failed.is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "draft");
    assert_eq!(state.object_map["new.md"], mapping);
    assert_eq!(mapped(&state), ["new.md"]);
}

/// An unmapped file at the target already holds the pulled bytes (a second tool
/// mirroring the vault): the note is adopted there and the old name removed.
/// The rename used to refuse it every cycle, and the push then uploaded the
/// target as a second object.
#[test]
fn a_pulled_rename_onto_a_file_holding_its_bytes_adopts_it() {
    let root = TempRoot::new();
    let mut state = connected();
    std::fs::write(root.path().join("old.md"), "body").unwrap();
    std::fs::write(root.path().join("new.md"), "edited").unwrap();
    let mapping = entry("object", Some(&hash_sha256("body")));
    state.object_map.insert("old.md".into(), mapping);

    let mut summary = SyncSummary::default();
    apply_remote(
        &mut state,
        root.path(),
        &remote("object", "new.md", "edited"),
        &HashMap::new(),
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();

    assert!(!root.path().join("old.md").exists());
    assert_eq!(read_content(root.path(), "new.md").unwrap(), "edited");
    assert_eq!(mapped(&state), ["new.md"]);
    assert_eq!(summary.renamed.len(), 1);
    assert_eq!(summary.renamed[0].from_id, "old");
    assert_eq!(summary.renamed[0].to_id, "new");
    assert_eq!(moves_in(&root), [("old.md".into(), "new.md".into(), true)]);
    assert_push_plans_nothing(&state, &root);
}

/// A target holding other bytes than the pulled ones is never adopted: it is
/// kept as a conflict copy and the note moves there.
#[test]
fn a_pulled_rename_onto_a_file_holding_other_bytes_keeps_that_file() {
    let root = TempRoot::new();
    let mut state = connected();
    std::fs::write(root.path().join("old.md"), "body").unwrap();
    std::fs::write(root.path().join("new.md"), "mine").unwrap();
    state
        .object_map
        .insert("old.md".into(), entry("object", Some(&hash_sha256("body"))));

    pull(&mut state, &root, &remote("object", "new.md", "edited"));

    assert_eq!(read_content(root.path(), "new.md").unwrap(), "edited");
    let copy = collision_conflict_filename("new.md", "object");
    assert_eq!(read_content(root.path(), &copy).unwrap(), "mine");
    assert!(!root.path().join("old.md").exists());
}

/// A case-only rename on a volume that folds case names one file twice: the
/// target "exists" because it is the note itself. Taken for an occupied
/// target, the note was refused the move, or parked as a stranger's file.
#[test]
fn a_pulled_case_only_rename_keeps_the_note() {
    let root = TempRoot::new();
    let mut state = connected();
    std::fs::write(root.path().join("Plan.md"), "body").unwrap();
    state.object_map.insert(
        "Plan.md".into(),
        entry("object", Some(&hash_sha256("body"))),
    );

    pull(&mut state, &root, &remote("object", "plan.md", "body"));

    let names: Vec<_> = local_files(root.path())
        .unwrap()
        .into_iter()
        .map(|file| file.name)
        .collect();
    assert_eq!(names, ["plan.md"]);
    assert_eq!(read_content(root.path(), "plan.md").unwrap(), "body");
    assert_eq!(mapped(&state), ["plan.md"]);
}

#[test]
fn a_pulled_rename_of_a_locally_changed_note_reports_its_park() {
    let root = TempRoot::new();
    let mut state = connected();
    std::fs::write(root.path().join("old.md"), "local edit").unwrap();
    state
        .object_map
        .insert("old.md".into(), entry("object", Some(&hash_sha256("body"))));

    pull(&mut state, &root, &remote("object", "new.md", "body"));

    let copy = collision_conflict_filename("old.md", "object");
    assert_eq!(moves_in(&root), [("old.md".into(), copy.clone(), true)]);
    assert_eq!(read_content(root.path(), &copy).unwrap(), "local edit");
}

#[test]
fn a_lost_name_collision_reports_the_move_under_the_guard() {
    let root = TempRoot::new();
    let mut state = connected();
    std::fs::write(root.path().join("note.md"), "local").unwrap();
    state.object_map.insert(
        "note.md".into(),
        entry("z-local", Some(&hash_sha256("local"))),
    );

    pull(&mut state, &root, &remote("a-remote", "note.md", "remote"));

    let conflict = collision_conflict_filename("note.md", "z-local");
    assert_eq!(moves_in(&root), [("note.md".into(), conflict, true)]);
}

#[test]
fn a_tombstone_park_reports_the_move_from_the_note_not_its_claim() {
    let root = TempRoot::new();
    let mut state = connected();
    std::fs::write(root.path().join("edited.md"), "local draft").unwrap();
    state.object_map.insert(
        "edited.md".into(),
        entry("edited-object", Some(&hash_sha256("old base"))),
    );
    futo_notes_core::files::on_note_moved(record);

    apply_tombstone(
        &mut state,
        root.path(),
        &object("edited-object", 6, true),
        &HashMap::new(),
        &no_pre,
        &mut SyncSummary::default(),
    )
    .unwrap();

    let copy = collision_conflict_filename("edited.md", "edited-object");
    assert_eq!(moves_in(&root), [("edited.md".into(), copy, true)]);
}

/// A save of an attached note takes the vault guard. Between a claim and its
/// park it found the note's file gone and recreated it beside the parked copy.
#[test]
fn a_tombstone_park_holds_the_guard_from_its_claim_to_its_park() {
    let saw_claim = Arc::new(AtomicBool::new(false));
    for _ in 0..40 {
        let root = TempRoot::new();
        std::fs::write(root.path().join("edited.md"), "local draft").unwrap();
        let mut state = connected();
        state.object_map.insert(
            "edited.md".into(),
            entry("edited-object", Some(&hash_sha256("old base"))),
        );
        let (claim, _) = claim_paths(root.path(), "edited.md", "edited-object");
        let stop = Arc::new(AtomicBool::new(false));
        let saver = {
            let (stop, saw_claim) = (stop.clone(), saw_claim.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let _vault = futo_notes_core::files::vault_mutation_guard().unwrap();
                    if claim.exists() {
                        saw_claim.store(true, Ordering::SeqCst);
                    }
                }
            })
        };
        apply_tombstone(
            &mut state,
            root.path(),
            &object("edited-object", 6, true),
            &HashMap::new(),
            &no_pre,
            &mut SyncSummary::default(),
        )
        .unwrap();
        stop.store(true, Ordering::SeqCst);
        saver.join().unwrap();
    }
    assert!(
        !saw_claim.load(Ordering::SeqCst),
        "a save ran between the claim and the park"
    );
}

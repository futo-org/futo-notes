use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use super::*;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "futo-notes-vault-migration-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        // Canonical, because `stage`/`inspect` canonicalize what they are
        // handed and the sync-ordering tests below compare observed paths
        // against ones built from this root. On macOS `temp_dir()` is
        // `/var/folders/…`, a symlink to `/private/var/folders/…`, so an
        // un-canonicalized root makes every such comparison fail there while
        // passing on Linux. Reproduce that locally with
        // `TMPDIR=<a symlink to a real dir> cargo test -p futo-notes-store`.
        Self(fs::canonicalize(&path).unwrap_or(path))
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct DirectorySyncHookGuard;

impl Drop for DirectorySyncHookGuard {
    fn drop(&mut self) {
        DIRECTORY_SYNC_HOOK.with(|hook| {
            hook.borrow_mut().take();
        });
    }
}

fn with_directory_sync_hook<T>(
    hook: impl FnMut(&Path) -> Result<(), String> + 'static,
    action: impl FnOnce() -> T,
) -> T {
    DIRECTORY_SYNC_HOOK.with(|slot| {
        assert!(slot.borrow().is_none(), "directory sync hook already set");
        *slot.borrow_mut() = Some(Box::new(hook));
    });
    let _guard = DirectorySyncHookGuard;
    action()
}

#[test]
fn stage_syncs_copied_directories_before_installing_destination() {
    let root = TestDirectory::new();
    let source = root.0.join("source");
    let destination = root.0.join("destination");
    fs::create_dir_all(source.join("Nested/Deep")).unwrap();
    fs::write(source.join("Nested/Deep/note.md"), "body").unwrap();
    let synced = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&synced);

    let outcome = with_directory_sync_hook(
        move |path| {
            observed.lock().unwrap().push(path.to_path_buf());
            Ok(())
        },
        || stage(&source, &destination),
    )
    .unwrap();

    assert_eq!(outcome.status, VaultMigrationStatus::Migrated);
    let synced = synced.lock().unwrap();
    let deep = synced
        .iter()
        .position(|path| path.ends_with("Nested/Deep"))
        .expect("deep staged directory was not synced");
    let nested = synced
        .iter()
        .position(|path| path.ends_with("Nested"))
        .expect("nested staged directory was not synced");
    let staging = synced
        .iter()
        .position(|path| {
            path.parent() == Some(root.0.as_path())
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(".destination.migration-"))
        })
        .expect("staging root was not synced");
    let destination_parent = synced
        .iter()
        .rposition(|path| path == &root.0)
        .expect("destination parent was not synced");
    assert!(deep < nested);
    assert!(nested < staging);
    assert!(staging < destination_parent);
}

#[test]
fn stage_does_not_install_when_staged_directory_sync_fails() {
    let root = TestDirectory::new();
    let source = root.0.join("source");
    let destination = root.0.join("destination");
    fs::create_dir_all(source.join("Nested")).unwrap();
    fs::write(source.join("Nested/note.md"), "body").unwrap();

    let result = with_directory_sync_hook(
        |_| Err("injected directory sync failure".into()),
        || stage(&source, &destination),
    );

    assert_eq!(
        result.unwrap_err(),
        "injected directory sync failure; the original notes folder remains unchanged"
    );
    assert!(source.join("Nested/note.md").exists());
    assert!(!destination.exists());
}

#[test]
fn stage_syncs_new_destination_parent_entries_through_the_existing_ancestor() {
    let root = TestDirectory::new();
    let source = root.0.join("source");
    let new_parent = root.0.join("New/Deep");
    let destination = new_parent.join("destination");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("note.md"), "body").unwrap();
    let synced = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&synced);

    with_directory_sync_hook(
        move |path| {
            observed.lock().unwrap().push(path.to_path_buf());
            Ok(())
        },
        || stage(&source, &destination),
    )
    .unwrap();

    let synced = synced.lock().unwrap();
    let deep = synced
        .iter()
        .rposition(|path| path == &new_parent)
        .expect("destination parent was not synced");
    let new = synced
        .iter()
        .rposition(|path| path == &root.0.join("New"))
        .expect("new parent entry was not synced");
    let existing = synced
        .iter()
        .rposition(|path| path == &root.0)
        .expect("existing ancestor was not synced");
    assert!(deep < new);
    assert!(new < existing);
}

#[test]
fn stage_retries_durability_for_an_already_installed_matching_destination() {
    let root = TestDirectory::new();
    let source = root.0.join("source");
    let new_parent = root.0.join("New/Deep");
    let destination = new_parent.join("destination");
    fs::create_dir_all(source.join("Nested")).unwrap();
    fs::write(source.join("Nested/note.md"), "body").unwrap();
    let failed_parent = root.0.join("New");

    let first_result = with_directory_sync_hook(
        move |path| {
            if path == failed_parent {
                Err("injected destination-parent sync failure".into())
            } else {
                Ok(())
            }
        },
        || stage(&source, &destination),
    );
    assert!(first_result.is_err());
    assert!(destination.join("Nested/note.md").exists());

    let synced = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&synced);
    let retry = with_directory_sync_hook(
        move |path| {
            observed.lock().unwrap().push(path.to_path_buf());
            Ok(())
        },
        || stage(&source, &destination),
    )
    .unwrap();

    assert_eq!(retry.status, VaultMigrationStatus::Migrated);
    let synced = synced.lock().unwrap();
    assert!(
        synced
            .iter()
            .any(|path| path == &destination.join("Nested")),
        "matching destination directory was not re-synced"
    );
    assert!(
        synced.iter().any(|path| path == &destination),
        "matching destination root was not re-synced"
    );
    assert!(
        synced.iter().any(|path| path == &new_parent),
        "matching destination immediate parent was not re-synced"
    );
    assert!(
        synced.iter().any(|path| path == &root.0.join("New")),
        "matching destination ancestor was not re-synced"
    );
    assert!(
        synced.iter().any(|path| path == &root.0),
        "matching destination existing ancestor was not re-synced"
    );
}

// ── destination inspection: migrate into empty, open occupied ──

#[test]
fn inspect_reports_an_absent_or_entryless_destination_as_empty() {
    let root = TestDirectory::new();
    let source = root.0.join("source");
    fs::create_dir_all(&source).unwrap();

    let absent = inspect(&source, &root.0.join("absent"));
    assert_eq!(absent.state, VaultDestinationState::Empty);
    assert_eq!(absent.notes, 0);

    let entryless = root.0.join("entryless");
    fs::create_dir_all(&entryless).unwrap();
    assert_eq!(
        inspect(&source, &entryless).state,
        VaultDestinationState::Empty
    );
}

#[test]
fn inspect_counts_the_notes_an_occupied_destination_already_holds() {
    let root = TestDirectory::new();
    let source = root.0.join("source");
    let destination = root.0.join("destination");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(destination.join("Folder")).unwrap();
    fs::write(destination.join("Kept.md"), "body").unwrap();
    fs::write(destination.join("Folder/Nested.md"), "body").unwrap();

    let inspection = inspect(&source, &destination);

    assert_eq!(inspection.state, VaultDestinationState::Occupied);
    assert_eq!(inspection.notes, 2);
    assert!(
        inspection.last_modified_ms > 0,
        "an occupied destination should report when its notes last changed"
    );
}

/// A folder holding only non-note files is still occupied — `stage` refuses
/// any non-empty destination — so it is opened, and honestly reports 0 notes.
#[test]
fn inspect_reports_a_destination_holding_no_notes_as_occupied_with_no_notes() {
    let root = TestDirectory::new();
    let source = root.0.join("source");
    let destination = root.0.join("destination");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join(".txt-migration-done"), "1").unwrap();

    let inspection = inspect(&source, &destination);

    assert_eq!(inspection.state, VaultDestinationState::Occupied);
    assert_eq!(inspection.notes, 0);
}

#[test]
fn inspect_rejects_a_file_or_a_destination_nested_with_the_source() {
    let root = TestDirectory::new();
    let source = root.0.join("source");
    fs::create_dir_all(&source).unwrap();
    let file = root.0.join("not-a-directory");
    fs::write(&file, "body").unwrap();

    assert_eq!(
        inspect(&source, &file).state,
        VaultDestinationState::Unusable
    );
    assert_eq!(
        inspect(&source, &source.join("inside")).state,
        VaultDestinationState::Unusable
    );
    assert_eq!(
        inspect(&source, source.parent().unwrap()).state,
        VaultDestinationState::Unusable
    );
}

/// Reproduces on Linux what only macOS CI hit: the same folder reached
/// through a symlinked ancestor. macOS `temp_dir()` is `/var/folders/…`, a
/// symlink to `/private/var/folders/…`, so the canonicalized source and the
/// absolutized-only destination shared no prefix and a nested destination
/// read as `Empty`. An explicit symlink makes the failure host-independent.
#[cfg(unix)]
#[test]
fn inspect_rejects_a_nested_destination_reached_through_a_symlinked_ancestor() {
    let root = TestDirectory::new();
    let real = root.0.join("real");
    let source = real.join("source");
    fs::create_dir_all(&source).unwrap();
    std::os::unix::fs::symlink(&real, root.0.join("link")).unwrap();

    let nested_via_symlink = root.0.join("link/source/inside");

    assert_eq!(
        inspect(&source, &nested_via_symlink).state,
        VaultDestinationState::Unusable,
        "a destination inside the current vault must be refused however its path spells it"
    );
}

#[cfg(unix)]
#[test]
fn stage_refuses_a_nested_destination_reached_through_a_symlinked_ancestor() {
    let root = TestDirectory::new();
    let real = root.0.join("real");
    let source = real.join("source");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("note.md"), "body").unwrap();
    std::os::unix::fs::symlink(&real, root.0.join("link")).unwrap();

    let result = stage(&source, &root.0.join("link/source/inside"));

    assert_eq!(
        result.unwrap_err(),
        "the new notes folder cannot contain or be contained by the current vault"
    );
    assert!(source.join("note.md").exists());
    assert!(!source.join("inside").exists());
}

#[test]
fn finalize_rechecks_a_retained_source_before_activation() {
    let root = TestDirectory::new();
    let source = root.0.join("source");
    let destination = root.0.join("destination");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("note.md"), "staged body").unwrap();

    stage(&source, &destination).unwrap();
    fs::write(source.join("note.md"), "late external edit").unwrap();

    assert_eq!(
        finalize(&source, &destination, false).unwrap(),
        VaultMigrationFinalization::DestinationChanged
    );
    assert!(source.exists());
    assert!(destination.exists());
}
#[test]
fn stage_preserves_each_copied_note_modified_time() {
    let root = TestDirectory::new();
    let source = root.0.join("source");
    let destination = root.0.join("destination");
    fs::create_dir_all(source.join("Folder")).unwrap();
    fs::write(source.join("old.md"), "old").unwrap();
    fs::write(source.join("Folder/newer.md"), "newer").unwrap();
    futo_notes_core::files::set_file_mtime_ms(&source.join("old.md"), 1_600_000_000_000).unwrap();
    futo_notes_core::files::set_file_mtime_ms(&source.join("Folder/newer.md"), 1_700_000_000_000)
        .unwrap();

    let outcome = stage(&source, &destination).unwrap();

    assert_eq!(outcome.status, VaultMigrationStatus::Migrated);
    assert_eq!(
        newest_modified_ms(&destination.join("old.md")),
        Some(1_600_000_000_000)
    );
    assert_eq!(
        newest_modified_ms(&destination.join("Folder/newer.md")),
        Some(1_700_000_000_000)
    );
}

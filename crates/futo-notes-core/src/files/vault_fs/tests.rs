use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use super::*;

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "futo-sync-vault-fs-test-{}-{}-{n}",
            std::process::id(),
            crate::files::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn write_reports_directory_sync_failure() {
    let root = TempRoot::new();
    platform::fail_directory_sync_on_call(1);

    let error = write_atomic(root.path(), "note.md", b"body").unwrap_err();

    assert!(error.contains("sync directory after write"));
}

#[test]
fn write_syncs_each_parent_entry_before_using_it() {
    let root = TempRoot::new();
    platform::fail_directory_sync_on_call(1);

    let first_error = write_atomic(root.path(), "folder/note.md", b"body").unwrap_err();

    assert!(first_error.contains("sync parent directory before mutation"));
    assert!(root.path().join("folder").is_dir());
    assert!(!root.path().join("folder/note.md").exists());

    platform::fail_directory_sync_on_call(1);
    let retry_error = write_atomic(root.path(), "folder/note.md", b"body").unwrap_err();

    assert!(retry_error.contains("sync parent directory before mutation"));
    assert!(!root.path().join("folder/note.md").exists());

    platform::fail_directory_sync_on_call(2);
    let nested_error = write_atomic(root.path(), "folder/nested/note.md", b"body").unwrap_err();

    assert!(nested_error.contains("sync parent directory before mutation"));
    assert!(root.path().join("folder/nested").is_dir());
    assert!(!root.path().join("folder/nested/note.md").exists());
}

#[test]
fn remove_reports_directory_sync_failure() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "body").unwrap();
    platform::fail_directory_sync_on_call(1);

    let error = remove(root.path(), "note.md").unwrap_err();

    assert!(error.contains("sync directory after remove"));
}

#[test]
fn remove_retry_resyncs_when_the_leaf_is_already_absent() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "body").unwrap();
    platform::fail_directory_sync_on_call(1);
    remove(root.path(), "note.md").unwrap_err();
    platform::fail_directory_sync_on_call(1);

    let error = remove(root.path(), "note.md").unwrap_err();

    assert!(error.contains("sync directory after remove"));
}

#[test]
fn absent_inspection_resyncs_before_callers_trust_the_missing_leaf() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "body").unwrap();
    platform::fail_directory_sync_on_call(1);
    remove(root.path(), "note.md").unwrap_err();
    platform::fail_directory_sync_on_call(1);

    let error = exists(root.path(), "note.md").unwrap_err();

    assert!(error.contains("sync directory before trusting absent path"));
}

#[test]
fn path_text_cannot_turn_a_non_missing_parent_error_into_not_found() {
    let root = TempRoot::new();
    std::fs::write(
        root.path().join("No such file or directory"),
        "not a directory",
    )
    .unwrap();
    let relative = "No such file or directory/note.md";

    assert!(remove(root.path(), relative).is_err());
    assert!(exists(root.path(), relative).is_err());
    assert!(rename(root.path(), relative, "destination.md").is_err());
}

#[test]
fn rename_reports_destination_directory_sync_failure() {
    let root = TempRoot::new();
    std::fs::create_dir(root.path().join("source")).unwrap();
    std::fs::create_dir(root.path().join("destination")).unwrap();
    std::fs::write(root.path().join("source/note.md"), "body").unwrap();
    platform::fail_directory_sync_on_call(3);

    let error = rename(root.path(), "source/note.md", "destination/note.md").unwrap_err();

    assert!(error.contains("sync destination directory after rename"));
}

#[test]
fn rename_retry_resyncs_when_only_the_destination_remains() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("source.md"), "body").unwrap();
    platform::fail_directory_sync_on_call(1);
    rename(root.path(), "source.md", "destination.md").unwrap_err();
    platform::fail_directory_sync_on_call(1);

    let error = rename(root.path(), "source.md", "destination.md").unwrap_err();

    assert!(error.contains("sync source directory after rename"));
}

#[test]
fn local_moves_report_committed_identity_when_directory_sync_fails() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("old.md"), "body").unwrap();
    platform::fail_directory_sync_on_call(1);
    assert!(move_no_replace(root.path(), "old.md", "new.md").unwrap());
    assert!(!root.path().join("old.md").exists());
    assert_eq!(read(root.path(), "new.md").unwrap(), b"body");
    platform::fail_directory_sync_on_call(1);
    rename_case(root.path(), "new.md", "NEW.md").unwrap();
    assert_eq!(read(root.path(), "NEW.md").unwrap(), b"body");
}

#[test]
fn local_create_and_write_preserve_best_effort_directory_sync() {
    let root = TempRoot::new();
    platform::fail_directory_sync_on_call(1);
    assert!(create_new(root.path(), "note.md", b"created").unwrap());
    platform::fail_directory_sync_on_call(1);
    write_atomic_local(root.path(), "note.md", b"edited").unwrap();
    assert_eq!(read(root.path(), "note.md").unwrap(), b"edited");
}

#[test]
fn descriptor_copy_fallback_keeps_collision_and_timestamp_contract() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("old.md"), "draft").unwrap();
    set_mtime_ms(root.path(), "old.md", 1_700_000_123_000).unwrap();
    platform::force_copy();
    assert!(move_no_replace(root.path(), "old.md", "new.md").unwrap());
    assert_eq!(read(root.path(), "new.md").unwrap(), b"draft");
    let time = filetime::FileTime::from_last_modification_time(
        &std::fs::metadata(root.path().join("new.md")).unwrap(),
    );
    assert_eq!(time.unix_seconds(), 1_700_000_123);
    platform::force_copy();
    assert!(!create_new(root.path(), "new.md", b"competing draft").unwrap());
    assert_eq!(read(root.path(), "new.md").unwrap(), b"draft");
    platform::force_copy();
    assert!(create_new(root.path(), "second.md", b"new draft").unwrap());
    assert_eq!(read(root.path(), "second.md").unwrap(), b"new draft");
}

#[test]
fn parked_backup_fallback_cleans_up_and_recovers_interruption() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "original").unwrap();
    platform::force_backup(false);
    platform::fail_directory_sync_on_call(1);
    write_atomic_local(root.path(), "note.md", b"edited").unwrap();
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    platform::force_backup(true);
    assert!(write_atomic_local(root.path(), "note.md", b"interrupted").is_err());
    let _ = crate::files::recover_parked_backups(root.path());
    assert_eq!(read(root.path(), "note.md").unwrap(), b"edited");
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn native_recursive_delete_does_not_follow_links() {
    use std::os::unix::fs::symlink;
    let root = TempRoot::new();
    let outside = TempRoot::new();
    std::fs::write(outside.path().join("keep.md"), "outside").unwrap();
    create_dir(root.path(), "folder").unwrap();
    symlink(outside.path(), root.path().join("folder/link")).unwrap();
    remove_dir(root.path(), "folder", true).unwrap();
    assert_eq!(
        std::fs::read_to_string(outside.path().join("keep.md")).unwrap(),
        "outside"
    );
    symlink(outside.path(), root.path().join("link")).unwrap();
    assert!(create_dir(root.path(), "link/created").is_err());
    assert!(remove_dir(root.path(), "link", true).is_err());
    clear(root.path()).unwrap();
    assert!(outside.path().join("keep.md").exists());
}

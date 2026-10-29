use super::*;
use futo_notes_core::hash::hash_sha256;

fn marker(root: &std::path::Path, id: &str, directory: bool, value: &str) -> std::path::PathBuf {
    let path = root.join(format!(
        ".futo-editor-recovery/{}.{}",
        hash_sha256(id),
        if directory {
            "directory-replacement"
        } else {
            "replacement"
        }
    ));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, value).unwrap();
    path
}

#[test]
fn folder_move_and_delete_protect_each_destination() {
    for delete in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let store = LocalNoteStore::new(root.path().to_owned());
        if delete {
            pending(&store, root.path(), "target");
            store.create_folder("from").unwrap();
            store.create("from", "target", "local edit").unwrap();
            let mutation = store.delete_folder("from").unwrap();
            assert_eq!(mutation.removed, ["from/target"]);
            assert_eq!(mutation.renamed.len(), 1);
            preserved(&store, "target");
        } else {
            store.create_folder("to/from").unwrap();
            pending(&store, root.path(), "to/from/target");
            std::fs::remove_dir(root.path().join("to/from")).unwrap();
            store.create_folder("from").unwrap();
            store.create("from", "target", "local edit").unwrap();
            let mutation = store.move_folder("from", "to").unwrap();
            assert_eq!(mutation.final_folder.as_deref(), Some("to/from"));
            preserved(&store, "to/from/target");
        }
    }
}

#[test]
fn case_note_and_directory_destinations_protect_pending_recovery() {
    for directory in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let store = LocalNoteStore::new(root.path().to_owned());
        if directory {
            store.create_folder("TO.md").unwrap();
            pending(&store, root.path(), "TO.md/target");
            std::fs::remove_dir(root.path().join("TO.md")).unwrap();
            store.create_folder("to.md").unwrap();
            store.create("to.md", "target", "local edit").unwrap();
            store.rename_folder("to.md", "TO.md").unwrap();
            preserved(&store, "TO.md/target");
        } else {
            pending(&store, root.path(), "TARGET");
            store.create("", "target", "local edit").unwrap();
            store.rename("target", "TARGET").unwrap();
            preserved(&store, "TARGET");
        }
    }
}

#[test]
fn bootstrap_failed_canonical_restore_retains_backup_and_sidecar_until_retry() {
    for invalid in ["broken", "18446744073709551615"] {
        let root = tempfile::tempdir().unwrap();
        let store = LocalNoteStore::new(root.path().to_owned());
        pending(&store, root.path(), "target");
        let path = marker(root.path(), "target", false, invalid);
        std::fs::write(root.path().join(".sf-bak-test"), "local edit").unwrap();
        std::fs::write(root.path().join(".sf-bak-test.path"), "target.md").unwrap();
        for _ in 0..2 {
            let result = store.bootstrap().unwrap();
            assert!(!result.warnings.is_empty());
            assert!(store.read_existing("target").unwrap().is_none());
            assert_eq!(
                std::fs::read_to_string(root.path().join(".sf-bak-test")).unwrap(),
                "local edit"
            );
            assert_eq!(
                std::fs::read_to_string(root.path().join(".sf-bak-test.path")).unwrap(),
                "target.md"
            );
        }
        std::fs::write(path, "0").unwrap();
        assert!(store.bootstrap().unwrap().warnings.is_empty());
        preserved(&store, "target");
    }
}

#[test]
fn corrupt_and_exhausted_directory_markers_fail_before_move_then_retry() {
    for invalid in ["broken", "18446744073709551615"] {
        let root = tempfile::tempdir().unwrap();
        let store = LocalNoteStore::new(root.path().to_owned());
        store.create_folder("to").unwrap();
        pending(&store, root.path(), "to/target");
        std::fs::remove_dir(root.path().join("to")).unwrap();
        store.create_folder("from").unwrap();
        store.create("from", "target", "local edit").unwrap();
        let path = marker(root.path(), "to", true, invalid);
        for _ in 0..2 {
            assert!(store.rename_folder("from", "to").is_err());
            assert_eq!(store.read("from/target").unwrap(), "local edit");
            assert!(store.read_existing("to/target").unwrap().is_none());
        }
        std::fs::write(path, "0").unwrap();
        store.rename_folder("from", "to").unwrap();
        preserved(&store, "to/target");
    }
}

#[test]
fn additive_epochs_preserve_old_leaf_headers_and_detect_small_prefix_increment() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create_folder("to/nested").unwrap();
    marker(root.path(), "to/nested/target", false, "900");
    pending(&store, root.path(), "to/nested/target");
    std::fs::remove_dir(root.path().join("to/nested")).unwrap();
    std::fs::remove_dir(root.path().join("to")).unwrap();
    store.create_folder("from/nested").unwrap();
    store.create("from/nested", "target", "local edit").unwrap();
    store.rename_folder("from", "to").unwrap();
    preserved(&store, "to/nested/target");
}

#[test]
fn failed_delete_folder_rolls_back_through_protected_source_destinations() {
    use std::sync::{Arc, Mutex};
    struct DenySecond {
        root: std::path::PathBuf,
        first: Mutex<Option<String>>,
    }
    impl futo_notes_store::BeforeWrite for DenySecond {
        fn before_write(&self, changes: &[futo_notes_store::FileChange]) {
            let moves: Vec<_> = changes
                .iter()
                .filter_map(|change| match change {
                    futo_notes_store::FileChange::Renamed { from, to } => Some((from, to)),
                    _ => None,
                })
                .collect();
            if moves.len() == 2 {
                *self.first.lock().unwrap() =
                    Some(moves[0].0.strip_suffix(".md").unwrap().to_owned());
                marker(
                    &self.root,
                    moves[1].1.strip_suffix(".md").unwrap(),
                    false,
                    "broken",
                );
            }
        }
    }
    let root = tempfile::tempdir().unwrap();
    let hook = Arc::new(DenySecond {
        root: root.path().to_owned(),
        first: Mutex::new(None),
    });
    let store = LocalNoteStore::with_before_write(root.path().to_owned(), hook.clone());
    store.create_folder("from").unwrap();
    for id in ["a", "b", "from/a", "from/b"] {
        pending(&store, root.path(), id);
        if id.starts_with("from/") {
            std::fs::write(root.path().join(format!("{id}.md")), "local edit").unwrap();
        }
    }
    assert!(store.delete_folder("from").is_err());
    assert_eq!(store.read("from/a").unwrap(), "local edit");
    assert_eq!(store.read("from/b").unwrap(), "local edit");
    assert!(store.read_existing("a").unwrap().is_none());
    assert!(store.read_existing("b").unwrap().is_none());
    let first = hook.first.lock().unwrap().clone().unwrap();
    preserved(&store, &first);
}

#[test]
fn bootstrap_serializes_txt_install_against_other_store_writers() {
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;
    struct Pause {
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl futo_notes_store::BeforeWrite for Pause {
        fn before_write(&self, changes: &[futo_notes_store::FileChange]) {
            if changes.iter().any(|change| {
                matches!(change,
                futo_notes_store::FileChange::Renamed { from, .. } if from == "target.txt")
            }) {
                self.entered.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            }
        }
    }
    let root = tempfile::tempdir().unwrap();
    let setup = LocalNoteStore::new(root.path().to_owned());
    pending(&setup, root.path(), "target");
    std::fs::write(root.path().join("target.txt"), "local edit").unwrap();
    let (entered_tx, entered) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    let bootstrap = LocalNoteStore::with_before_write(
        root.path().to_owned(),
        Arc::new(Pause {
            entered: entered_tx,
            release: Mutex::new(release_rx),
        }),
    );
    std::thread::scope(|scope| {
        let boot = scope.spawn(|| bootstrap.bootstrap().unwrap());
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        let (started_tx, started) = mpsc::channel();
        let (done_tx, done) = mpsc::channel();
        let setup = &setup;
        let writer = scope.spawn(move || {
            started_tx.send(()).unwrap();
            let result = setup.write("other", "serialized outside write", None);
            done_tx.send(result).unwrap();
        });
        started.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(
            done.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        release.send(()).unwrap();
        assert!(boot.join().unwrap().warnings.is_empty());
        done.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        writer.join().unwrap();
    });
    preserved(&setup, "target");
}

#[test]
fn leaf_increment_does_not_copy_ancestor_epoch_into_raw_leaf() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create_folder("to").unwrap();
    marker(root.path(), "to/target", false, "18446744073709551605");
    marker(root.path(), "to", true, "5");
    pending(&store, root.path(), "to/target");
    store.write("to/target", "local edit", None).unwrap();
    preserved(&store, "to/target");
}

#[test]
fn aggregate_overflow_refuses_leaf_install_without_changing_note_or_stream() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create_folder("to").unwrap();
    pending(&store, root.path(), "to/target");
    let prefix = marker(root.path(), "to", true, "18446744073709551615");
    let leaf = marker(root.path(), "to/target", false, "1");
    assert!(store.write("to/target", "must not install", None).is_err());
    assert!(store.read_existing("to/target").unwrap().is_none());
    // Repair the deliberately corrupt fixture, then retry through the public owner.
    std::fs::write(prefix, "0").unwrap();
    std::fs::write(leaf, "0").unwrap();
    store.write("to/target", "local edit", None).unwrap();
    preserved(&store, "to/target");
}

#[test]
fn directory_process_death_retains_pending_draft_across_each_install_boundary() {
    for phase in ["before-marker", "after-marker", "after-install"] {
        let root = tempfile::tempdir().unwrap();
        let store = LocalNoteStore::new(root.path().to_owned());
        store.create_folder("to").unwrap();
        pending(&store, root.path(), "to/target");
        std::fs::remove_dir(root.path().join("to")).unwrap();
        store.create_folder("from").unwrap();
        store.create("from", "target", "local edit").unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "destination_failures::directory_death_child",
                "--nocapture",
            ])
            .env("FUTO_DIRECTORY_DEATH_ROOT", root.path())
            .env("FUTO_DIRECTORY_DEATH_PHASE", phase)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(76), "{phase}");
        if phase != "after-install" {
            assert_eq!(store.read("from/target").unwrap(), "local edit");
            assert!(store.read_existing("to/target").unwrap().is_none());
            store.rename_folder("from", "to").unwrap();
        }
        preserved(&store, "to/target");
    }
}

#[test]
fn directory_death_child() {
    struct Exit;
    impl futo_notes_store::BeforeWrite for Exit {
        fn before_write(&self, _: &[futo_notes_store::FileChange]) {
            std::process::exit(76);
        }
    }
    let Some(root) = std::env::var_os("FUTO_DIRECTORY_DEATH_ROOT") else {
        return;
    };
    let phase = std::env::var("FUTO_DIRECTORY_DEATH_PHASE").unwrap();
    let store = if phase == "before-marker" {
        LocalNoteStore::with_before_write(root.into(), std::sync::Arc::new(Exit))
    } else {
        LocalNoteStore::new(root.into())
    };
    if phase == "after-marker" {
        futo_notes_core::files::vault_fs::set_before_install_hook(Some(Box::new(|relative| {
            if relative == "to" {
                std::process::exit(76);
            }
        })));
    }
    store.rename_folder("from", "to").unwrap();
    std::process::exit(76);
}

#[test]
fn failed_txt_migration_retains_source_and_retries_after_marker_repair() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    pending(&store, root.path(), "target");
    let path = marker(root.path(), "target", false, "broken");
    std::fs::write(root.path().join("target.txt"), "local edit").unwrap();
    let denied = store.bootstrap().unwrap();
    assert_eq!(denied.migrated, 0);
    assert!(!denied.warnings.is_empty());
    assert_eq!(
        std::fs::read_to_string(root.path().join("target.txt")).unwrap(),
        "local edit"
    );
    assert!(store.read_existing("target").unwrap().is_none());
    std::fs::write(path, "0").unwrap();
    let retried = store.bootstrap().unwrap();
    assert_eq!(retried.migrated, 1);
    assert!(retried.warnings.is_empty());
    preserved(&store, "target");
}

#[test]
fn directory_install_refuses_corrupt_or_exhausted_ancestor_prefix() {
    for invalid in ["broken", "18446744073709551615"] {
        let root = tempfile::tempdir().unwrap();
        let store = LocalNoteStore::new(root.path().to_owned());
        store.create_folder("to/nested").unwrap();
        pending(&store, root.path(), "to/nested/target");
        std::fs::remove_dir(root.path().join("to/nested")).unwrap();
        store.create_folder("from").unwrap();
        store.create("from", "target", "local edit").unwrap();
        let path = marker(root.path(), "to", true, invalid);
        assert!(store.rename_folder("from", "to/nested").is_err());
        assert_eq!(store.read("from/target").unwrap(), "local edit");
        assert!(store.read_existing("to/nested/target").unwrap().is_none());
        std::fs::write(path, "0").unwrap();
        store.rename_folder("from", "to/nested").unwrap();
        preserved(&store, "to/nested/target");
    }
}

#[test]
fn parallel_nested_backup_recovery_keeps_original_vault_root_for_coordination() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    for folder in ["one", "two"] {
        store.create_folder(folder).unwrap();
        pending(&store, root.path(), &format!("{folder}/target"));
        std::fs::write(
            root.path().join(format!("{folder}/.sf-bak-test")),
            "local edit",
        )
        .unwrap();
        std::fs::write(
            root.path().join(format!("{folder}/.sf-bak-test.path")),
            "target.md",
        )
        .unwrap();
    }
    assert!(store.bootstrap().unwrap().warnings.is_empty());
    preserved(&store, "one/target");
    preserved(&store, "two/target");
}

#[cfg(unix)]
#[test]
fn prefix_marker_directory_sync_failure_prevents_install_and_retains_retry() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create_folder("to").unwrap();
    pending(&store, root.path(), "to/target");
    std::fs::remove_dir(root.path().join("to")).unwrap();
    store.create_folder("from").unwrap();
    store.create("from", "target", "local edit").unwrap();
    // The local metadata install may tolerate unsupported directory fsync;
    // the coordinator's explicit durable parent check must still fail closed.
    futo_notes_core::files::vault_fs::fail_directory_sync_on_call(3);
    assert!(store.rename_folder("from", "to").is_err());
    assert_eq!(store.read("from/target").unwrap(), "local edit");
    assert!(store.read_existing("to/target").unwrap().is_none());
    store.rename_folder("from", "to").unwrap();
    preserved(&store, "to/target");
}

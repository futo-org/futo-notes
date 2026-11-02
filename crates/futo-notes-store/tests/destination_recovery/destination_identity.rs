use super::*;

#[test]
fn move_through_existing_folder_alias_protects_the_physical_destinations_stream() {
    for directory in [false, true] {
        for (physical, alias) in [("to", "TO"), ("caf\u{e9}", "cafe\u{301}")] {
            let root = tempfile::tempdir().unwrap();
            let store = LocalNoteStore::new(root.path().to_owned());
            store.create_folder(physical).unwrap();
            if !root.path().join(alias).is_dir() {
                eprintln!(
                    "filesystem does not alias {physical:?} and {alias:?}; capability unavailable"
                );
                continue;
            }
            let destination = if directory {
                format!("{physical}/nested")
            } else {
                physical.to_owned()
            };
            if directory {
                store.create_folder(&destination).unwrap();
            }
            let id = format!("{destination}/target");
            pending(&store, root.path(), &id);
            if directory {
                std::fs::remove_dir(root.path().join(&destination)).unwrap();
            }
            store.create_folder("from").unwrap();
            store.create("from", "target", "local edit").unwrap();
            if directory {
                let requested = format!("{alias}/nested");
                let moved = store.rename_folder("from", &requested).unwrap();
                assert_eq!(moved.final_folder.as_deref(), Some(requested.as_str()));
            } else {
                let moved = store.move_note("from/target", alias).unwrap();
                assert_eq!(moved.final_id, Some(format!("{alias}/target")));
            }
            preserved(&store, &id);
        }
    }
}

#[test]
fn legacy_folder_moves_do_not_initialize_portable_recovery_metadata() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create_folder("from").unwrap();
    store.create("from", "target", "legacy note").unwrap();
    store.rename_folder("from", "to").unwrap();
    assert_eq!(store.read("to/target").unwrap(), "legacy note");
    assert!(!root.path().join(".futo-editor-recovery").exists());
}

#[test]
fn shared_alias_counter_corruption_and_overflow_fail_before_install() {
    use futo_notes_core::{files::collision_key, hash::hash_sha256};
    for invalid in ["broken", "18446744073709551615"] {
        let root = tempfile::tempdir().unwrap();
        let store = LocalNoteStore::new(root.path().to_owned());
        pending(&store, root.path(), "target");
        let path = root.path().join(format!(
            ".futo-editor-recovery/{}.collision-replacement",
            hash_sha256(&collision_key("target"))
        ));
        std::fs::write(&path, invalid).unwrap();
        for _ in 0..2 {
            assert!(store.write("target", "must not install", None).is_err());
            assert!(store.read_existing("target").unwrap().is_none());
        }
        std::fs::write(path, "0").unwrap();
        store.write("target", "local edit", None).unwrap();
        preserved(&store, "target");
    }
}

#[test]
fn first_append_waits_for_directory_install_that_started_without_recovery_metadata() {
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;
    struct Pause {
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl futo_notes_store::BeforeWrite for Pause {
        fn before_write(&self, _: &[futo_notes_store::FileChange]) {
            self.entered.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
        }
    }
    for incoming in ["local edit", "outside"] {
        let root = tempfile::tempdir().unwrap();
        let store = LocalNoteStore::new(root.path().to_owned());
        store.create_folder("to").unwrap();
        store.create("to", "target", "local edit").unwrap();
        let mut editor = store.open_editor("to/target").unwrap();
        assert!(!root.path().join(".futo-editor-recovery").exists());
        std::fs::remove_file(root.path().join("to/target.md")).unwrap();
        std::fs::remove_dir(root.path().join("to")).unwrap();
        store.create_folder("from").unwrap();
        store.create("from", "target", incoming).unwrap();
        let (entered_tx, entered) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let writer = LocalNoteStore::with_before_write(
            root.path().to_owned(),
            Arc::new(Pause {
                entered: entered_tx,
                release: Mutex::new(release_rx),
            }),
        );
        std::thread::scope(|scope| {
            // Drop the sender before scoped joins if an observation panics.
            let release_before_join = release;
            let install = scope.spawn(move || writer.rename_folder("from", "to"));
            entered.recv_timeout(Duration::from_secs(5)).unwrap();
            super::scoped_pause::abort_if_requested();
            let (attempt_tx, attempt) = mpsc::channel();
            let (accepted_tx, accepted) = mpsc::channel();
            let editor = &mut editor;
            let append = scope.spawn(move || {
                attempt_tx.send(()).unwrap();
                let result = editor.replace(
                    Revision(0),
                    DisplayRange {
                        start: DisplayOffset(10),
                        end: DisplayOffset(10),
                    },
                    " older draft",
                );
                accepted_tx.send(()).unwrap();
                result
            });
            attempt.recv_timeout(Duration::from_secs(5)).unwrap();
            let blocked = matches!(
                accepted.recv_timeout(Duration::from_millis(75)),
                Err(mpsc::RecvTimeoutError::Timeout)
            );
            release_before_join.send(()).unwrap();
            install.join().unwrap().unwrap();
            append.join().unwrap().unwrap();
            assert!(blocked, "first append must wait for directory installation");
        });
        assert_eq!(editor.source_text(), "local edit older draft");
        let saved = editor.checkpoint().unwrap();
        if incoming == "outside" {
            let FlushDisposition::ParkedConflict { parked_id } = saved.disposition else {
                panic!("outside bytes must survive");
            };
            assert_eq!(store.read("to/target").unwrap(), "outside");
            assert_eq!(store.read(&parked_id).unwrap(), "local edit older draft");
        } else {
            assert_eq!(saved.disposition, FlushDisposition::Wrote);
            assert_eq!(store.read("to/target").unwrap(), "local edit older draft");
        }
    }
}

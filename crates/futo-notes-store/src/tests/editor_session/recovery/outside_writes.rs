use super::*;

#[test]
fn intentional_restore_of_old_checkpoint_preserves_recovered_draft_and_complete_mutation() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "one\r\ntwo  ").unwrap();
    {
        let mut editor = store.open_editor("plain").unwrap();
        editor.replace(Revision(0), range(5, 8), "three").unwrap();
        assert_eq!(editor.source_text(), "one\r\nthree  ");
    }
    // An intentional restore is meaningful even when it restores the exact
    // checkpoint against which the pending draft was originally accepted.
    let restored = store.write("plain", "one\r\ntwo  ", None).unwrap();
    assert_eq!(restored.final_id.as_deref(), Some("plain"));
    let mut editor = store.open_editor("plain").unwrap();
    assert_eq!(editor.source_text(), "one\r\nthree  ");
    let saved = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = saved.disposition else {
        panic!("intentional restore must survive pending draft recovery");
    };
    let mutation = saved.mutation.unwrap();
    assert_eq!(mutation.final_id.as_deref(), Some(parked_id.as_str()));
    assert_eq!(mutation.upserted.len(), 1);
    assert_eq!(mutation.upserted[0].note.id, parked_id);
    assert_eq!(mutation.upserted[0].note.preview, "one three");
    assert!(mutation.removed.is_empty());
    assert!(mutation.renamed.is_empty());
    assert!(mutation.folders.is_empty());
    assert!(mutation.relinked.is_empty());
    assert!(mutation.warnings.is_empty());
    assert_eq!(mutation.final_folder, None);
    assert_eq!(store.read("plain").unwrap(), "one\r\ntwo  ");
    assert_eq!(store.read(&parked_id).unwrap(), "one\r\nthree  ");
    let snapshot = store.snapshot();
    assert_eq!(snapshot.notes.len(), 2);
    assert_eq!(
        snapshot.notes[mutation.upserted[0].position as usize].id,
        parked_id
    );
    drop(editor);
    for _ in 0..2 {
        store.open_editor("plain").unwrap().checkpoint().unwrap();
        assert_eq!(store.snapshot().notes.len(), 2);
        assert_eq!(store.read("plain").unwrap(), "one\r\ntwo  ");
    }
}

#[test]
fn replacement_after_committed_checkpoint_does_not_retire_the_only_draft() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    editor.set_retirement_failure(true);
    assert!(matches!(
        editor.checkpoint(),
        Err(EditorStoreError::CheckpointCommitted { .. })
    ));
    store.write("plain", "plain", None).unwrap();
    editor.set_retirement_failure(false);
    let saved = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = saved.disposition else {
        panic!("retry must preserve replacement and draft");
    };
    assert_eq!(store.read("plain").unwrap(), "plain");
    assert_eq!(store.read(&parked_id).unwrap(), "plain!");
    assert_eq!(
        saved.mutation.unwrap().final_id.as_deref(),
        Some(parked_id.as_str())
    );
    assert_eq!(store.snapshot().notes.len(), 2);
}

#[test]
fn controlled_recreate_of_old_checkpoint_preserves_pending_draft() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    {
        let mut editor = store.open_editor("plain").unwrap();
        editor.replace(Revision(0), range(5, 5), "!").unwrap();
    }
    // An external filesystem input removes the file; a supported create then
    // deliberately installs an independent note with the old checkpoint bytes.
    fs::remove_file(root.0.join("plain.md")).unwrap();
    store.create("", "plain", "plain").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    let saved = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = saved.disposition else {
        panic!("a newly installed note must survive recovery of the earlier draft");
    };
    assert_eq!(store.read("plain").unwrap(), "plain");
    assert_eq!(store.read(&parked_id).unwrap(), "plain!");
    assert_eq!(store.snapshot().notes.len(), 2);
}

#[test]
fn backlink_rewrite_restoring_old_checkpoint_preserves_pending_draft() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "Target", "target").unwrap();
    store.create("", "plain", "[[Target]]").unwrap();
    {
        let mut editor = store.open_editor("plain").unwrap();
        editor.replace(Revision(0), range(10, 10), "!").unwrap();
    }
    store.rename("Target", "Renamed").unwrap();
    assert_eq!(store.read("plain").unwrap(), "[[Renamed]]");
    store.rename("Renamed", "Target").unwrap();
    assert_eq!(store.read("plain").unwrap(), "[[Target]]");
    let mut editor = store.open_editor("plain").unwrap();
    let saved = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = saved.disposition else {
        panic!("recovery must preserve the intentional backlink rewrite");
    };
    assert_eq!(store.read("plain").unwrap(), "[[Target]]");
    assert_eq!(store.read(&parked_id).unwrap(), "[[Target]]!");
    assert_eq!(store.snapshot().notes.len(), 3);
}

#[test]
fn interrupted_park_with_replaced_destination_preserves_all_versions_on_repeated_recovery() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let first_park;
    {
        let mut editor = store.open_editor("plain").unwrap();
        editor.replace(Revision(0), range(5, 5), "!").unwrap();
        store.write("plain", "outside\r\nbytes  ", None).unwrap();
        editor.set_retirement_failure(true);
        let Err(EditorStoreError::CheckpointCommitted { result, .. }) = editor.checkpoint() else {
            panic!("expected committed park with retained recovery");
        };
        let FlushDisposition::ParkedConflict { parked_id } = result.disposition else {
            panic!("outside bytes require a park");
        };
        first_park = parked_id;
    }
    store
        .write(&first_park, "independent parked replacement", None)
        .unwrap();
    for attempt in 0..2 {
        let mut editor = store.open_editor("plain").unwrap();
        assert_eq!(
            editor.source_text(),
            if attempt == 0 {
                "plain!"
            } else {
                "outside\r\nbytes  "
            }
        );
        editor.checkpoint().unwrap();
        assert_eq!(store.read("plain").unwrap(), "outside\r\nbytes  ");
        assert_eq!(
            store.read(&first_park).unwrap(),
            "independent parked replacement"
        );
        let mut contents: Vec<_> = store
            .snapshot()
            .notes
            .iter()
            .map(|note| store.read(&note.id).unwrap())
            .collect();
        contents.sort();
        assert_eq!(
            contents,
            [
                "independent parked replacement",
                "outside\r\nbytes  ",
                "plain!"
            ]
        );
    }
}

#[test]
fn checkpoint_retirement_and_outside_write_share_one_decision_window() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    editor.set_retirement_failure(true);
    let writer = LocalNoteStore::new(root.0.clone());
    let (start_tx, start_rx) = mpsc::channel();
    let (attempt_tx, attempt_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let outside = std::thread::spawn(move || {
        start_rx.recv().unwrap();
        attempt_tx.send(()).unwrap();
        let result = writer.write("plain", "plain", None);
        done_tx.send(()).unwrap();
        result
    });
    let observed = Arc::new(Mutex::new(None));
    let recorder = observed.clone();
    let start = Mutex::new(Some(start_tx));
    let attempt = Mutex::new(attempt_rx);
    let done = Arc::new(Mutex::new(done_rx));
    let done_in_hook = done.clone();
    store.set_flush_window_hook(Box::new(move |_| {
        let Some(start_tx) = start.lock().unwrap().take() else {
            return;
        };
        if start_tx.send(()).is_err() || attempt.lock().unwrap().recv().is_err() {
            return;
        }
        *recorder.lock().unwrap() = Some(
            done_in_hook
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_millis(75))
                .is_err(),
        );
    }));
    assert!(matches!(
        editor.checkpoint(),
        Err(EditorStoreError::CheckpointCommitted { .. })
    ));
    outside.join().unwrap().unwrap();
    assert_eq!(
        *observed.lock().unwrap(),
        Some(true),
        "outside writer must wait until checkpoint releases its guard"
    );
    editor.set_retirement_failure(false);
    let saved = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = saved.disposition else {
        panic!("the later replacement and earlier draft must both survive");
    };
    assert_eq!(store.read("plain").unwrap(), "plain");
    assert_eq!(store.read(&parked_id).unwrap(), "plain!");
    assert_eq!(store.snapshot().notes.len(), 2);
}

#[test]
fn first_recovery_append_cannot_enter_an_outside_write_decision_window() {
    struct PausedWrite {
        entered: mpsc::Sender<()>,
        resume: Mutex<mpsc::Receiver<()>>,
    }
    impl BeforeWrite for PausedWrite {
        fn before_write(&self, _: &[FileChange]) {
            self.entered.send(()).unwrap();
            self.resume.lock().unwrap().recv().unwrap();
        }
    }
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    // Opening is deliberately lazy: no recovery stream exists until input.
    let mut editor = store.open_editor("plain").unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let outside_store = LocalNoteStore::with_before_write(
        root.0.clone(),
        Arc::new(PausedWrite {
            entered: entered_tx,
            resume: Mutex::new(resume_rx),
        }),
    );
    let writer = std::thread::spawn(move || outside_store.write("plain", "plain", None));
    // Replacement intent has been checked, but installation is still pending.
    entered_rx.recv().unwrap();
    let (attempt_tx, attempt_rx) = mpsc::channel();
    let (accepted_tx, accepted_rx) = mpsc::channel();
    let blocked = std::thread::scope(|scope| {
        // Drop the sender before scoped joins if an observation panics.
        let resume_before_join = resume_tx;
        let append = scope.spawn(|| {
            attempt_tx.send(()).unwrap();
            let result = editor.replace(Revision(0), range(5, 5), "!");
            accepted_tx.send(()).unwrap();
            result
        });
        attempt_rx.recv().unwrap();
        let blocked = accepted_rx.recv_timeout(Duration::from_millis(75)).is_err();
        resume_before_join.send(()).unwrap();
        writer.join().unwrap().unwrap();
        append.join().unwrap().unwrap();
        blocked
    });
    assert!(
        blocked,
        "first recovery append must wait for outside installation"
    );
    assert_eq!(editor.source_text(), "plain!");
    editor.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), "plain!");
}

#[test]
fn supported_save_append_and_flush_protect_pending_recovery() {
    for operation in ["save", "append", "flush"] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "plain", "plain").unwrap();
        {
            let mut editor = store.open_editor("plain").unwrap();
            editor.replace(Revision(0), range(5, 5), "!").unwrap();
        }
        let outside = match operation {
            "save" => {
                store.save(Some("plain"), "plain", "plain", None).unwrap();
                "plain"
            }
            "append" => {
                store.append("plain", " outside\r\n").unwrap();
                "plain outside\r\n"
            }
            "flush" => {
                assert_eq!(
                    store
                        .flush_draft("plain", "plain", "plain")
                        .unwrap()
                        .disposition,
                    FlushDisposition::Converged
                );
                "plain"
            }
            _ => unreachable!(),
        };
        let mut editor = store.open_editor("plain").unwrap();
        let saved = editor.checkpoint().unwrap();
        let FlushDisposition::ParkedConflict { parked_id } = saved.disposition else {
            panic!("{operation} must preserve the outside version");
        };
        assert_eq!(store.read("plain").unwrap(), outside);
        assert_eq!(store.read(&parked_id).unwrap(), "plain!");
        assert_eq!(store.snapshot().notes.len(), 2);
    }
}

#[test]
fn process_death_around_replacement_install_preserves_draft_and_is_idempotent() {
    for phase in ["before-install", "after-install"] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "plain", "plain").unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::editor_session::recovery::outside_writes::replacement_death_child",
                "--nocapture",
            ])
            .env("FUTO_EDITOR_REPLACEMENT_VAULT", &root.0)
            .env("FUTO_EDITOR_REPLACEMENT_PHASE", phase)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(75), "{phase}");
        for attempt in 0..2 {
            let mut editor = store.open_editor("plain").unwrap();
            if attempt == 0 {
                assert_eq!(editor.source_text(), "plain!");
            }
            editor.checkpoint().unwrap();
            assert_eq!(store.read("plain").unwrap(), "plain");
            let mut contents: Vec<_> = store
                .snapshot()
                .notes
                .iter()
                .map(|note| store.read(&note.id).unwrap())
                .collect();
            contents.sort();
            assert_eq!(contents, ["plain", "plain!"], "{phase}");
        }
    }
}

#[test]
fn replacement_death_child() {
    let Some(root) = std::env::var_os("FUTO_EDITOR_REPLACEMENT_VAULT") else {
        return;
    };
    let store = LocalNoteStore::new(root.into());
    if std::env::var("FUTO_EDITOR_REPLACEMENT_PHASE").unwrap() == "before-install" {
        futo_notes_core::files::vault_fs::set_before_install_hook(Some(Box::new(|relative| {
            if relative == "plain.md" {
                std::process::exit(75);
            }
        })));
    }
    {
        let mut editor = store.open_editor("plain").unwrap();
        editor.replace(Revision(0), range(5, 5), "!").unwrap();
    }
    store.write("plain", "plain", None).unwrap();
    std::process::exit(75);
}

#[test]
fn parking_into_an_absent_target_with_pending_recovery_preserves_both_drafts() {
    let root = TestRoot::new();
    let store = store(&root);
    let target = format!("plain (conflict {})", current_conflict_date());
    store.create("", &target, "plain!").unwrap();
    {
        let mut editor = store.open_editor(&target).unwrap();
        editor
            .replace(Revision(0), range(6, 6), " older draft")
            .unwrap();
    }
    // A deterministic external input removes only the old checkpoint.
    fs::remove_file(root.0.join(format!("{target}.md"))).unwrap();
    store.create("", "plain", "plain").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    store.write("plain", "outside", None).unwrap();
    for _ in 0..2 {
        let Err(EditorStoreError::CheckpointCommitted { result, .. }) = editor.checkpoint() else {
            panic!("foreign recovery must retain the original session's log");
        };
        assert_eq!(
            result.disposition,
            FlushDisposition::ParkedConflict {
                parked_id: target.clone()
            }
        );
        let mutation = result.mutation.unwrap();
        assert_eq!(mutation.final_id.as_deref(), Some(target.as_str()));
        assert_eq!(mutation.upserted.len(), 1);
        assert_eq!(mutation.upserted[0].note.id, target);
        assert_eq!(
            store.snapshot().notes[mutation.upserted[0].position as usize].id,
            target
        );
        assert!(mutation.removed.is_empty());
        assert!(mutation.renamed.is_empty());
        assert!(mutation.relinked.is_empty());
        assert!(mutation.folders.is_empty());
        assert!(mutation.warnings.is_empty());
        assert_eq!(mutation.final_folder, None);
        assert_eq!(editor.id(), "plain");
        assert_eq!(editor.source_text(), "plain!");
        assert!(editor.recovery_status().paused);
        assert!(matches!(
            editor.resume_recovery(),
            Err(EditorStoreError::CheckpointPending)
        ));
        assert!(matches!(
            editor.replace(Revision(1), range(6, 6), "?"),
            Err(EditorStoreError::CheckpointPending)
        ));
    }
    drop(editor);
    let mut editor = store.open_editor("plain").unwrap();
    assert_eq!(editor.source_text(), "plain!");
    assert!(editor.recovery_status().paused);
    // Recover the target's untouched foreign stream through its own session.
    let mut older = store.open_editor(&target).unwrap();
    assert_eq!(older.source_text(), "plain! older draft");
    assert_eq!(older.revision(), Revision(1));
    older.checkpoint().unwrap();
    drop(older);
    editor.checkpoint().unwrap();
    assert_eq!(editor.id(), target);
    assert!(!editor.recovery_status().paused);
    assert_eq!(store.read("plain").unwrap(), "outside");
    assert_eq!(
        store.read(&target).unwrap(),
        "plain!",
        "newly parked draft must survive recovery of the older target stream"
    );
    drop(editor);
    // Reopening either original identity cannot mint another copy or lose a draft.
    for id in ["plain", target.as_str()] {
        store.open_editor(id).unwrap().checkpoint().unwrap();
    }
    let mut contents: Vec<_> = store
        .snapshot()
        .notes
        .iter()
        .map(|note| store.read(&note.id).unwrap())
        .collect();
    contents.sort();
    assert_eq!(contents, ["outside", "plain!", "plain! older draft"]);
}

#[test]
fn checkpoint_retry_projects_the_current_position_after_an_unrelated_write() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    editor.set_retirement_failure(true);
    assert!(matches!(
        editor.checkpoint(),
        Err(EditorStoreError::CheckpointCommitted { .. })
    ));
    // Use an explicit later timestamp so ranking is deterministic on every FS.
    store
        .write("later", "unrelated", Some(4_000_000_000_000))
        .unwrap();
    editor.set_retirement_failure(false);
    let result = editor.checkpoint().unwrap();
    let mutation = result.mutation.unwrap();
    assert_eq!(mutation.upserted.len(), 1);
    assert_eq!(mutation.upserted[0].note.id, "plain");
    assert_eq!(
        store.snapshot().notes[mutation.upserted[0].position as usize].id,
        "plain",
        "retry must project its current authoritative position"
    );
}

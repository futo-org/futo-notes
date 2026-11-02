use super::*;
use storage::{Disk, Fault};

#[test]
fn recovery_acknowledgements_advance_only_after_successful_acceptance_and_flush() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    assert_eq!(editor.recovery_status().accepted, Revision(0));
    assert_eq!(editor.recovery_status().durable, Revision(0));
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    assert_eq!(editor.recovery_status().accepted, Revision(1));
    assert_eq!(editor.recovery_status().durable, Revision(0));
    editor.flush_recovery().unwrap();
    assert_eq!(editor.recovery_status().durable, Revision(1));
    editor.undo(Revision(1)).unwrap().unwrap();
    assert_eq!(editor.recovery_status().accepted, Revision(2));
    assert_eq!(editor.recovery_status().durable, Revision(1));
    editor.checkpoint().unwrap();
    assert_eq!(editor.recovery_status().durable, Revision(2));
    editor.redo(Revision(2)).unwrap().unwrap();
    assert_eq!(editor.recovery_status().accepted, Revision(3));
    assert_eq!(editor.recovery_status().durable, Revision(2));
}

#[derive(Default)]
struct ManualRecoveryClock(std::sync::atomic::AtomicU64);

impl RecoveryClock for ManualRecoveryClock {
    fn now(&self) -> Duration {
        Duration::from_millis(self.0.load(std::sync::atomic::Ordering::SeqCst))
    }
}

impl ManualRecoveryClock {
    fn at(&self, millis: u64) {
        self.0.store(millis, std::sync::atomic::Ordering::SeqCst);
    }
}

#[test]
fn recovery_flush_deadline_tracks_the_oldest_unflushed_edit_without_debouncing() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let clock = Arc::new(ManualRecoveryClock::default());
    let mut editor = store
        .open_editor_with_recovery(
            "plain",
            RecoveryOptions {
                clock: clock.clone(),
                ..RecoveryOptions::default()
            },
        )
        .unwrap();
    assert_eq!(editor.recovery_status().flush_deadline, None);
    clock.at(10);
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    assert_eq!(
        editor.recovery_status().flush_deadline,
        Some(Duration::from_millis(110))
    );
    assert_eq!(
        editor.recovery_flush_delay(),
        Some(Duration::from_millis(100))
    );
    clock.at(109);
    assert_eq!(
        editor.recovery_flush_delay(),
        Some(Duration::from_millis(1))
    );
    editor.replace(Revision(1), range(6, 6), "?").unwrap();
    assert!(!editor.flush_recovery_if_due().unwrap());
    assert_eq!(editor.recovery_status().durable, Revision(0));
    clock.at(110);
    assert_eq!(editor.recovery_flush_delay(), Some(Duration::ZERO));
    assert!(editor.flush_recovery_if_due().unwrap());
    assert_eq!(editor.recovery_flush_delay(), None);
    assert_eq!(editor.recovery_status().durable, Revision(2));
    assert_eq!(editor.recovery_status().flush_deadline, None);
    clock.at(200);
    editor.undo(Revision(2)).unwrap();
    assert_eq!(
        editor.recovery_status().flush_deadline,
        Some(Duration::from_millis(300))
    );
    clock.at(350);
    assert!(editor.flush_recovery_if_due().unwrap());
    assert_eq!(editor.recovery_status().durable, Revision(3));
    assert_eq!(
        editor.recovery_status().last_flush_lateness,
        Some(Duration::from_millis(50))
    );
}

#[test]
fn failed_append_retains_the_draft_and_requires_successful_repair_before_resume() {
    for fault in [Fault::Append, Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "plain", "plain").unwrap();
        let disk = Arc::new(Mutex::new(Disk::default()));
        let mut editor = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap();
        editor.replace(Revision(0), range(5, 5), "!").unwrap();
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.replace(Revision(1), range(6, 6), "?"),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), "plain!");
        assert_eq!(editor.recovery_status().accepted, Revision(1));
        assert_eq!(editor.recovery_status().durable, Revision(0));
        assert!(editor.recovery_status().paused);
        disk.lock().unwrap().fault = Some(Fault::Truncate);
        assert!(matches!(
            editor.resume_recovery(),
            Err(EditorStoreError::RecoveryResume(_))
        ));
        assert!(matches!(
            editor.undo(Revision(1)),
            Err(EditorStoreError::RecoveryPaused)
        ));
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        assert!(!editor.recovery_status().paused);
        assert_eq!(editor.recovery_status().durable, Revision(1));
        editor.replace(Revision(1), range(6, 6), "?").unwrap();
        drop(editor);
        let recovered = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), "plain!?");
    }
}

#[test]
fn process_death_and_power_loss_keep_different_acknowledged_prefixes() {
    for (power_loss, flush_first, expected) in [
        (false, false, "plain!?"),
        (true, false, "plain"),
        (true, true, "plain!"),
    ] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "plain", "plain").unwrap();
        let disk = Arc::new(Mutex::new(Disk::default()));
        {
            let mut editor = store
                .open_editor_with_recovery("plain", storage::options(&disk))
                .unwrap();
            editor.replace(Revision(0), range(5, 5), "!").unwrap();
            if flush_first {
                editor.flush_recovery().unwrap();
            }
            editor.replace(Revision(1), range(6, 6), "?").unwrap();
        }
        // Process death preserves OS-accepted bytes; power loss discards every
        // byte that this filesystem model has not successfully flushed.
        if power_loss {
            disk.lock().unwrap().power_loss();
        }
        let recovered = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), expected);
        assert_eq!(store.read("plain").unwrap(), "plain");
    }
}

#[test]
fn failed_scheduled_flush_never_acknowledges_durability_and_pauses_new_edits() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let disk = Arc::new(Mutex::new(Disk::default()));
    let clock = Arc::new(ManualRecoveryClock::default());
    let mut options = storage::options(&disk);
    options.clock = clock.clone();
    let mut editor = store.open_editor_with_recovery("plain", options).unwrap();
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    editor.flush_recovery().unwrap();
    editor.replace(Revision(1), range(6, 6), "?").unwrap();
    disk.lock().unwrap().fault = Some(Fault::Flush);
    clock.at(100);
    assert!(matches!(
        editor.flush_recovery_if_due(),
        Err(EditorStoreError::RecoveryFlush(_))
    ));
    assert_eq!(editor.recovery_status().accepted, Revision(2));
    assert_eq!(editor.recovery_status().durable, Revision(1));
    assert_eq!(
        editor.recovery_status().flush_deadline,
        Some(Duration::from_millis(100))
    );
    assert_eq!(editor.source_text(), "plain!?");
    assert!(matches!(
        editor.replace(Revision(2), range(7, 7), "x"),
        Err(EditorStoreError::RecoveryPaused)
    ));
    assert!(matches!(
        editor.resume_recovery(),
        Err(EditorStoreError::RecoveryResume(_))
    ));
    assert!(editor.recovery_status().paused);
    drop(editor);
    disk.lock().unwrap().power_loss();
    disk.lock().unwrap().fault = None;
    let recovered = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap();
    assert_eq!(recovered.source_text(), "plain!");
}

#[test]
fn failed_markdown_checkpoint_keeps_a_healthy_log_and_does_not_pause_typing() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    let directory = root.0.clone();
    store.set_flush_window_hook(Box::new(move |_| {
        fs::rename(directory.join("plain.md"), directory.join("saved-original")).unwrap();
        fs::create_dir(directory.join("plain.md")).unwrap();
    }));
    assert!(matches!(
        editor.checkpoint(),
        Err(EditorStoreError::Checkpoint(_))
    ));
    // The destination intent was flushed before the markdown install failed.
    assert_eq!(editor.recovery_status().durable, Revision(1));
    assert!(!editor.recovery_status().paused);
    editor.replace(Revision(1), range(6, 6), "?").unwrap();
    editor.flush_recovery().unwrap();
    assert_eq!(editor.recovery_status().durable, Revision(2));
    store.set_flush_window_hook(Box::new(|_| {}));
    fs::remove_dir(root.0.join("plain.md")).unwrap();
    fs::rename(root.0.join("saved-original"), root.0.join("plain.md")).unwrap();
    drop(editor);
    let mut recovered = store.open_editor("plain").unwrap();
    assert_eq!(recovered.source_text(), "plain!?");
    assert_eq!(
        recovered.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    assert_eq!(store.read("plain").unwrap(), "plain!?");
}

#[test]
fn recovery_open_and_initial_create_failures_propagate_without_accepting_edits() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let disk = Arc::new(Mutex::new(Disk::default()));
    disk.lock().unwrap().fault = Some(Fault::Open);
    assert!(matches!(
        store.open_editor_with_recovery("plain", storage::options(&disk)),
        Err(EditorStoreError::Recovery(_))
    ));
    disk.lock().unwrap().fault = Some(Fault::Create);
    let mut editor = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap();
    assert!(matches!(
        editor.replace(Revision(0), range(5, 5), "!"),
        Err(EditorStoreError::RecoveryAppend(_))
    ));
    assert_eq!(editor.source_text(), "plain");
    assert_eq!(editor.recovery_status().accepted, Revision(0));
    assert_eq!(editor.recovery_status().durable, Revision(0));
    assert!(editor.recovery_status().paused);
    disk.lock().unwrap().fault = None;
    editor.resume_recovery().unwrap();
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), "plain!");
}

#[test]
fn rejected_input_does_not_advance_recovery_or_pause_a_healthy_session() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    let accepted = editor.recovery_status();
    assert!(matches!(
        editor.replace(Revision(0), range(6, 6), "?"),
        Err(EditorStoreError::Editor(_))
    ));
    assert_eq!(editor.recovery_status(), accepted);
    assert_eq!(editor.source_text(), "plain!");
    editor.flush_recovery().unwrap();
    assert_eq!(editor.recovery_status().durable, Revision(1));
}

#[test]
fn retirement_failure_is_retryable_without_repeating_the_committed_save() {
    let root = TestRoot::new();
    let observer = Arc::new(RecordingObserver::default());
    let store = LocalNoteStore::with_before_write(root.0.clone(), observer.clone());
    store.create("", "plain", "plain").unwrap();
    observer.0.lock().unwrap().clear();
    let disk = Arc::new(Mutex::new(Disk::default()));
    let mut editor = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap();
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    disk.lock().unwrap().fault = Some(Fault::Retire);
    let EditorStoreError::CheckpointCommitted { result, .. } = editor.checkpoint().unwrap_err()
    else {
        panic!("must report committed mutation");
    };
    assert_eq!(result.mutation.unwrap().upserted[0].note.id, "plain");
    assert_eq!(store.read("plain").unwrap(), "plain!");
    assert!(editor.recovery_status().paused);
    assert_eq!(editor.recovery_status().durable, Revision(1));
    assert_eq!(observer.0.lock().unwrap().len(), 1);
    disk.lock().unwrap().fault = None;
    editor.checkpoint().unwrap();
    assert_eq!(observer.0.lock().unwrap().len(), 1);
    assert_eq!(editor.recovery_status().durable, Revision(1));
    assert!(!editor.recovery_status().paused);
}

#[test]
fn failed_grouped_undo_short_write_preserves_the_entire_draft_and_retries_one_record() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "history", "__a__").unwrap();
    let disk = Arc::new(Mutex::new(Disk::default()));
    let clock = Arc::new(ManualRecoveryClock::default());
    let mut options = storage::options(&disk);
    options.clock = clock;
    let mut editor = store.open_editor_with_recovery("history", options).unwrap();
    editor.replace(Revision(0), range(1, 1), "b").unwrap();
    editor.replace(Revision(1), range(2, 2), "c").unwrap();
    disk.lock().unwrap().fault = Some(Fault::ShortWrite);
    assert!(editor.undo(Revision(2)).is_err());
    assert_eq!(editor.source_text(), "__abc__");
    assert_eq!(editor.revision(), Revision(2));
    assert_eq!(editor.recovery_status().accepted, Revision(2));
    assert!(editor.recovery_status().paused);
    disk.lock().unwrap().fault = None;
    editor.resume_recovery().unwrap();
    editor.undo(Revision(2)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "__a__");
    assert_eq!(editor.recovery_status().accepted, Revision(3));
    assert!(editor.undo(Revision(3)).unwrap().is_none());
    drop(editor);
    let mut recovered = store
        .open_editor_with_recovery("history", storage::options(&disk))
        .unwrap();
    assert_eq!(recovered.source_text(), "__a__");
    assert_eq!(recovered.revision(), Revision(3));
    assert!(recovered.undo(Revision(3)).unwrap().is_none());
}

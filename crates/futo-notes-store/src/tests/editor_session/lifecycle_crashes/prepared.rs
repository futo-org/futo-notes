use super::*;
use futo_notes_editor::SessionToken;

const SOURCE: &str = "```Rust\nab\n```\n";

#[cfg(unix)]
fn options(io: &Arc<Mutex<PreparedIo>>) -> RecoveryOptions {
    let defaults = RecoveryOptions::default();
    RecoveryOptions {
        clock: defaults.clock,
        storage: Box::new(CrashStorage {
            inner: defaults.storage,
            phase: String::new(),
            prepared_io: Some(io.clone()),
        }),
    }
}

#[cfg(unix)]
#[derive(Default)]
struct Clock(std::sync::atomic::AtomicU64);
#[cfg(unix)]
impl RecoveryClock for Clock {
    fn now(&self) -> Duration {
        Duration::from_millis(self.0.load(std::sync::atomic::Ordering::SeqCst))
    }
}

#[cfg(unix)]
#[test]
fn first_prepared_short_write_repairs_inactive_prefix_without_rewriting_the_base() {
    let root = TestRoot::new();
    let store = store(&root);
    let source = format!("```Rust\n{}```\n\n__tail__", "alpha beta\n".repeat(1_000));
    store.create("", "old", &source).unwrap();
    let io = Arc::new(Mutex::new(PreparedIo::default()));
    let clock = Arc::new(Clock::default());
    let mut options = options(&io);
    options.clock = clock.clone();
    let editor = store.open_editor_with_recovery("old", options).unwrap();
    let mut bounded = editor
        .into_bounded(Revision(0), SessionToken(91), DisplayOffset(0))
        .unwrap();
    let prepared_bytes = io.lock().unwrap().created_bytes;
    assert!(prepared_bytes > source.len());
    assert!(
        !futo_notes_core::files::recovery_coordination::has_pending_recovery(&root.0, "old")
            .unwrap()
    );
    let cursor = bounded.cursor().unwrap();
    io.lock().unwrap().short_write = true;
    assert!(matches!(
        bounded.insert_literal(cursor, DisplayOffset(1), "x"),
        Err(EditorStoreError::RecoveryAppend(_))
    ));
    assert_eq!(bounded.source_text(), source);
    assert_eq!(bounded.cursor().unwrap(), cursor);
    let failed = bounded.recovery_status();
    assert!(failed.paused);
    assert_eq!(failed.accepted, Revision(0));
    assert_eq!(failed.durable, Revision(0));
    assert_eq!(failed.flush_deadline, None);
    assert_eq!(io.lock().unwrap().activations, 0);
    bounded.resume_recovery().unwrap();
    assert!(!bounded.recovery_status().paused);
    assert!(
        !futo_notes_core::files::recovery_coordination::has_pending_recovery(&root.0, "old")
            .unwrap()
    );
    clock.0.store(10, std::sync::atomic::Ordering::SeqCst);
    bounded
        .insert_literal(cursor, DisplayOffset(1), "x")
        .unwrap();
    let deadline = Some(Duration::from_millis(110));
    assert_eq!(bounded.recovery_status().flush_deadline, deadline);
    clock.0.store(50, std::sync::atomic::Ordering::SeqCst);
    bounded
        .insert_literal(bounded.cursor().unwrap(), DisplayOffset(2), "y")
        .unwrap();
    assert_eq!(bounded.recovery_status().flush_deadline, deadline);
    let io = io.lock().unwrap();
    assert_eq!(
        io.created_bytes, prepared_bytes,
        "first input must not create another full header"
    );
    assert_eq!(
        io.replaced_bytes, 0,
        "first input must not replace a full header either"
    );
    assert!(
        io.appended_bytes < 1_024,
        "only the small attempted/retried frames reach append"
    );
    assert_eq!(io.activations, 1);
    drop(io);
    let expected = source.replacen("alpha", "axylpha", 1);
    assert_eq!(bounded.source_text(), expected);
    drop(bounded);
    let reopened = store.open_editor("old").unwrap();
    assert_eq!(reopened.source_text(), expected);
    assert_eq!(reopened.revision(), Revision(2));
    assert_eq!(store.read("old").unwrap(), source);
}

#[cfg(unix)]
#[test]
fn installed_first_frame_sync_failure_repairs_owned_authority_before_retry() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", SOURCE).unwrap();
    let io = Arc::new(Mutex::new(PreparedIo::default()));
    let editor = store
        .open_editor_with_recovery("old", options(&io))
        .unwrap();
    let mut bounded = editor
        .into_bounded(Revision(0), SessionToken(92), DisplayOffset(0))
        .unwrap();
    let prepared_bytes = io.lock().unwrap().created_bytes;
    let cursor = bounded.cursor().unwrap();
    io.lock().unwrap().activation_sync_failure = true;
    assert!(matches!(
        bounded.insert_literal(cursor, DisplayOffset(1), "x"),
        Err(EditorStoreError::RecoveryAppend(_))
    ));
    assert!(
        futo_notes_core::files::recovery_coordination::has_pending_recovery(&root.0, "old")
            .unwrap()
    );
    assert_eq!(bounded.cursor().unwrap(), cursor);
    assert_eq!(bounded.source_text(), SOURCE);
    let failed = bounded.recovery_status();
    assert!(failed.paused);
    assert_eq!(failed.accepted, Revision(0));
    assert_eq!(failed.durable, Revision(0));
    // An external actor can replace the canonical name after installation.
    // Resume must keep that foreign inode untouched and remain paused.
    let canonical = root.0.join(format!(
        ".futo-editor-recovery/{}.jsonl",
        futo_notes_core::hash::hash_sha256("old")
    ));
    fs::remove_file(&canonical).unwrap();
    fs::write(&canonical, b"foreign recovery bytes").unwrap();
    assert!(matches!(
        bounded.resume_recovery(),
        Err(EditorStoreError::RecoveryResume(_))
    ));
    assert!(bounded.recovery_status().paused);
    assert_eq!(fs::read(&canonical).unwrap(), b"foreign recovery bytes");
    // Remove precisely the foreign fixture this test created; the original
    // inactive inode remains owned and repairs without a canonical link.
    fs::remove_file(&canonical).unwrap();
    bounded.resume_recovery().unwrap();
    assert!(!bounded.recovery_status().paused);
    assert!(
        !futo_notes_core::files::recovery_coordination::has_pending_recovery(&root.0, "old")
            .unwrap()
    );
    bounded
        .insert_literal(cursor, DisplayOffset(1), "x")
        .unwrap();
    assert_eq!(bounded.source_text(), "```Rust\naxb\n```\n");
    assert_eq!(bounded.recovery_status().accepted, Revision(1));
    assert_eq!(bounded.recovery_status().durable, Revision(0));
    bounded.flush_recovery().unwrap();
    assert_eq!(bounded.recovery_status().durable, Revision(1));
    let io = io.lock().unwrap();
    assert_eq!(io.created_bytes, prepared_bytes);
    assert_eq!(io.replaced_bytes, 0);
    assert_eq!(io.activations, 2);
    drop(io);
    drop(bounded);
    let reopened = store.open_editor("old").unwrap();
    assert_eq!(reopened.source_text(), "```Rust\naxb\n```\n");
    assert_eq!(reopened.revision(), Revision(1));
    assert_eq!(store.read("old").unwrap(), SOURCE);
}

#[cfg(unix)]
fn inactive_paths(root: &Path) -> Vec<std::path::PathBuf> {
    fs::read_dir(root.join(".futo-editor-recovery"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "prepared")
        })
        .collect()
}

#[cfg(unix)]
#[test]
fn failed_materializing_exit_keeps_the_original_bounded_owner_until_cleanup_succeeds() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", SOURCE).unwrap();
    let io = Arc::new(Mutex::new(PreparedIo::default()));
    let mut editor = store
        .open_editor_with_recovery("old", options(&io))
        .unwrap();
    editor.replace(Revision(0), range(1, 1), "x").unwrap();
    editor.checkpoint().unwrap();
    let bounded = editor
        .into_bounded(Revision(1), SessionToken(95), DisplayOffset(1))
        .unwrap();
    let cursor = bounded.cursor().unwrap();
    let source = bounded.source_text();
    let status = bounded.recovery_status();
    io.lock().unwrap().discard_failure = true;
    let failure = bounded
        .into_full()
        .err()
        .expect("cleanup must fail before releasing ownership");
    assert!(matches!(failure.error, EditorStoreError::Recovery(_)));
    let bounded = failure.session;
    assert!(
        !bounded.reset_required(),
        "a failed prerequisite must retain the original bounded owner"
    );
    assert_eq!(bounded.cursor().unwrap(), cursor);
    assert_eq!(bounded.source_text(), source);
    assert_eq!(bounded.recovery_status(), status);
    assert!(matches!(
        store.open_editor("old"),
        Err(EditorStoreError::SessionAlreadyOpen)
    ));
    let (mut editor, _) = bounded.into_full().unwrap();
    editor.undo(Revision(1)).unwrap().unwrap();
    assert_eq!(editor.source_text(), SOURCE);
}

#[cfg(unix)]
#[test]
fn prepared_clean_drop_keeps_an_outside_write_and_removes_only_its_owned_inactive_file() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", SOURCE).unwrap();
    let editor = store.open_editor("old").unwrap();
    let bounded = editor
        .into_bounded(Revision(0), SessionToken(93), DisplayOffset(0))
        .unwrap();
    let owned = inactive_paths(&root.0);
    assert_eq!(owned.len(), 1);
    let foreign = root.0.join(".futo-editor-recovery/unrelated.prepared");
    fs::write(&foreign, b"unrelated inert artifact").unwrap();
    assert!(
        !futo_notes_core::files::recovery_coordination::has_pending_recovery(&root.0, "old")
            .unwrap()
    );
    store.write("old", "outside clean bytes", None).unwrap();
    drop(bounded);
    assert!(owned.iter().all(|path| !path.exists()));
    assert_eq!(fs::read(&foreign).unwrap(), b"unrelated inert artifact");
    let reopened = store.open_editor("old").unwrap();
    assert_eq!(reopened.source_text(), "outside clean bytes");
    assert_eq!(reopened.revision(), Revision(0));
    assert_eq!(reopened.recovery_issue(), None);
    assert_eq!(store.snapshot().notes.len(), 1);
}

#[cfg(unix)]
#[test]
fn process_death_before_or_after_prepared_activation_preserves_epoch_and_authority() {
    for phase in ["bounded-before-activation", "bounded-after-activation"] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "old", SOURCE).unwrap();
        child_workflow(&root.0, phase, "bounded");
        // exit74 is emitted only by the named activation hook, after the first
        // attempted frame was written. An ordinary panic/success is not proof.
        let orphan = inactive_paths(&root.0);
        assert_eq!(orphan.len(), 1, "{phase}");
        let installed = phase == "bounded-after-activation";
        assert_eq!(
            futo_notes_core::files::recovery_coordination::has_pending_recovery(&root.0, "old")
                .unwrap(),
            installed
        );
        let mut reopened = store.open_editor("old").unwrap();
        assert_eq!(
            reopened.source_text(),
            if installed {
                "```Rust\naxb\n```\n"
            } else {
                SOURCE
            },
            "{phase}"
        );
        assert_eq!(reopened.revision(), Revision(u64::from(installed)));
        if installed {
            assert_eq!(
                reopened.recovery_issue().unwrap().kind,
                RecoveryIssueKind::BaseMismatch,
                "same-byte outside replacement must keep the prepared header's original epoch"
            );
            let checkpoint = reopened.checkpoint().unwrap();
            let FlushDisposition::ParkedConflict { parked_id } = checkpoint.disposition else {
                panic!("outside replacement was overwritten: {phase}");
            };
            assert_eq!(store.read(&parked_id).unwrap(), "```Rust\naxb\n```\n");
            assert_eq!(store.snapshot().notes.len(), 2);
        } else {
            assert_eq!(reopened.recovery_issue(), None);
            reopened.checkpoint().unwrap();
            assert_eq!(store.snapshot().notes.len(), 1);
        }
        assert_eq!(store.read("old").unwrap(), SOURCE);
        assert!(
            orphan.iter().all(|path| path.exists()),
            "restart must not adopt or sweep an ambiguous inert artifact"
        );
    }
}

pub(super) fn death_child(store: &LocalNoteStore, phase: &str) {
    let defaults = RecoveryOptions::default();
    let editor = store
        .open_editor_with_recovery(
            "old",
            RecoveryOptions {
                clock: defaults.clock,
                storage: Box::new(CrashStorage {
                    inner: defaults.storage,
                    phase: phase.to_owned(),
                    prepared_io: None,
                }),
            },
        )
        .unwrap();
    let mut bounded = editor
        .into_bounded(Revision(0), SessionToken(94), DisplayOffset(0))
        .unwrap();
    // The bytes deliberately stay equal: only the retained original epoch can
    // distinguish this outside replacement from the session's clean baseline.
    store.write("old", SOURCE, None).unwrap();
    bounded
        .insert_literal(bounded.cursor().unwrap(), DisplayOffset(1), "x")
        .unwrap();
    panic!("bounded activation interruption did not fire: {phase}");
}

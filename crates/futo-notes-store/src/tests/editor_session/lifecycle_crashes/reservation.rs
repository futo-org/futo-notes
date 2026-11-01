use super::*;
use futo_notes_core::files::recovery_coordination::{has_pending_recovery, replacement_epoch};
use futo_notes_core::hash::hash_sha256;
use futo_notes_editor::SessionToken;

const SOURCE: &str = "```Rust\nab\n```\n";

fn canonical(root: &Path) -> std::path::PathBuf {
    root.join(format!(
        ".futo-editor-recovery/{}.jsonl",
        hash_sha256("old")
    ))
}

#[cfg(unix)]
fn options(io: &Arc<Mutex<ReservationIo>>) -> RecoveryOptions {
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

/// A complete checksummed header frame as written by a v3 or v4 writer.
fn header(root: &Path, version: u32, base: &str, source: Option<&str>, revision: u64) -> Vec<u8> {
    let payload = serde_json::json!({
        "version": version,
        "vault": root.canonicalize().unwrap().to_string_lossy(),
        "id": "old",
        "base": base,
        "source": source,
        "base_revision": revision,
        "replacement_epoch": replacement_epoch(root, "old").unwrap(),
    })
    .to_string();
    let mut bytes = serde_json::to_vec(
        &serde_json::json!({"payload": payload, "sha256": hash_sha256(&payload)}),
    )
    .unwrap();
    bytes.push(b'\n');
    bytes
}

#[test]
fn only_an_exact_v4_header_is_a_reservation_while_v3_header_source_stays_authoritative() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "current").unwrap();
    fs::create_dir_all(canonical(&root.0).parent().unwrap()).unwrap();
    fs::write(
        canonical(&root.0),
        header(&root.0, 3, "current", Some("draft"), 3),
    )
    .unwrap();
    let draft = store.open_editor("old").unwrap();
    assert_eq!(draft.source_text(), "draft");
    assert_eq!(draft.revision(), Revision(3));
    assert_eq!(draft.recovery_issue(), None);
    drop(draft);

    // Nonzero stale base: a clean reservation opens current disk and is retired.
    fs::write(canonical(&root.0), header(&root.0, 4, "stale", None, 5)).unwrap();
    let clean = store.open_editor("old").unwrap();
    assert_eq!(clean.source_text(), "current");
    assert_eq!(clean.revision(), Revision(0));
    assert_eq!(clean.recovery_issue(), None);
    assert!(!clean.recovery_status().paused);
    assert!(!canonical(&root.0).exists());
    drop(clean);

    // Following bytes use ordinary frame validation, never provisional.
    let mut torn = header(&root.0, 4, "stale", None, 5);
    torn.extend_from_slice(b"{\"payload\"");
    fs::write(canonical(&root.0), &torn).unwrap();
    let retained = store.open_editor("old").unwrap();
    assert_eq!(
        retained.recovery_issue().unwrap().kind,
        RecoveryIssueKind::TornTail
    );
    assert!(retained.recovery_status().paused);
    assert_eq!(fs::read(canonical(&root.0)).unwrap(), torn);
}

#[cfg(unix)]
#[test]
fn first_frame_failure_repairs_the_nonzero_reservation_and_keeps_its_original_epoch() {
    let root = TestRoot::new();
    let store = store(&root);
    let source = format!("```Rust\n{}```\n\n__tail__", "alpha beta\n".repeat(1_000));
    store.create("", "old", &source).unwrap();
    let io = Arc::new(Mutex::new(ReservationIo::default()));
    let clock = Arc::new(Clock::default());
    let mut options = options(&io);
    options.clock = clock.clone();
    let mut editor = store.open_editor_with_recovery("old", options).unwrap();
    editor.replace(Revision(0), range(1, 1), "y").unwrap();
    editor.checkpoint().unwrap();
    let base = source.replacen("alpha", "aylpha", 1);
    let created = io.lock().unwrap().created_bytes;
    let mut bounded = editor
        .into_bounded(Revision(1), SessionToken(91), DisplayOffset(0))
        .unwrap();
    let reserved = io.lock().unwrap().created_bytes - created;
    assert!(reserved > base.len());
    assert!(has_pending_recovery(&root.0, "old").unwrap());
    // Same bytes, new epoch: only the reservation's original epoch can tell.
    store.write("old", &base, None).unwrap();
    let cursor = bounded.cursor().unwrap();
    io.lock().unwrap().fail = Some("append");
    assert!(matches!(
        bounded.insert_literal(cursor, DisplayOffset(1), "x"),
        Err(EditorStoreError::RecoveryAppend(_))
    ));
    assert_eq!(bounded.source_text(), base);
    let failed = bounded.recovery_status();
    assert!(failed.paused);
    assert_eq!(
        (failed.accepted, failed.durable),
        (Revision(1), Revision(1))
    );
    assert_eq!(failed.flush_deadline, None);
    bounded.resume_recovery().unwrap();
    clock.0.store(10, std::sync::atomic::Ordering::SeqCst);
    bounded
        .insert_literal(cursor, DisplayOffset(1), "x")
        .unwrap();
    assert_eq!(
        bounded.recovery_status().flush_deadline,
        Some(Duration::from_millis(110))
    );
    let io = io.lock().unwrap();
    assert_eq!(io.created_bytes, created + reserved, "no second header");
    assert_eq!(io.replaced_bytes, 0);
    assert!(io.appended_bytes < 1_024, "only small frames are appended");
    drop(io);
    let expected = source.replacen("alpha", "axylpha", 1);
    assert_eq!(bounded.source_text(), expected);
    drop(bounded);
    let reopened = store.open_editor("old").unwrap();
    assert_eq!(reopened.source_text(), expected);
    assert_eq!(reopened.revision(), Revision(2));
    assert_eq!(
        reopened.recovery_issue().unwrap().kind,
        RecoveryIssueKind::BaseMismatch
    );
}

#[cfg(unix)]
#[test]
fn failed_materializing_exit_keeps_the_original_bounded_owner_until_cleanup_succeeds() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", SOURCE).unwrap();
    let io = Arc::new(Mutex::new(ReservationIo::default()));
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
    io.lock().unwrap().fail = Some("remove_reservation");
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
    assert!(!canonical(&root.0).exists());
    editor.undo(Revision(1)).unwrap().unwrap();
    assert_eq!(editor.source_text(), SOURCE);
}

#[cfg(unix)]
#[test]
fn clean_drop_removes_only_its_reservation_and_keeps_an_outside_write() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", SOURCE).unwrap();
    let editor = store.open_editor("old").unwrap();
    let bounded = editor
        .into_bounded(Revision(0), SessionToken(93), DisplayOffset(0))
        .unwrap();
    assert!(has_pending_recovery(&root.0, "old").unwrap());
    store.write("old", "outside clean bytes", None).unwrap();
    drop(bounded);
    assert!(!canonical(&root.0).exists());
    let reopened = store.open_editor("old").unwrap();
    assert_eq!(reopened.source_text(), "outside clean bytes");
    assert_eq!(reopened.revision(), Revision(0));
    assert_eq!(reopened.recovery_issue(), None);
    assert_eq!(store.snapshot().notes.len(), 1);
}

#[cfg(unix)]
#[test]
fn process_death_after_reservation_or_first_frame_preserves_authority() {
    for phase in ["bounded-reserved", "bounded-first-frame"] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "old", SOURCE).unwrap();
        child_workflow(&root.0, phase, "bounded");
        // exit74 comes only from the named hook. A panic/success is no proof.
        assert!(has_pending_recovery(&root.0, "old").unwrap(), "{phase}");
        if phase == "bounded-reserved" {
            // Full reopen retires the clean reservation before editing;
            // a failed retirement keeps current markdown and pauses input.
            let io = Arc::new(Mutex::new(ReservationIo {
                fail: Some("pin"),
                ..Default::default()
            }));
            let mut reopened = store
                .open_editor_with_recovery("old", options(&io))
                .unwrap();
            assert_eq!(reopened.source_text(), SOURCE);
            assert_eq!(reopened.revision(), Revision(0));
            assert!(reopened.recovery_status().paused);
            assert!(canonical(&root.0).exists());
            reopened.resume_recovery().unwrap();
            assert!(!canonical(&root.0).exists());
            reopened.replace(Revision(0), range(1, 1), "y").unwrap();
            drop(reopened);
            assert_eq!(store.open_editor("old").unwrap().revision(), Revision(1));
            continue;
        }
        let mut reopened = store.open_editor("old").unwrap();
        assert_eq!(reopened.source_text(), "```Rust\naxb\n```\n");
        assert_eq!(reopened.revision(), Revision(1));
        assert_eq!(
            reopened.recovery_issue().unwrap().kind,
            RecoveryIssueKind::BaseMismatch,
            "same-byte outside replacement keeps the reservation's original epoch"
        );
        let checkpoint = reopened.checkpoint().unwrap();
        let FlushDisposition::ParkedConflict { parked_id } = checkpoint.disposition else {
            panic!("outside replacement was overwritten");
        };
        assert_eq!(store.read(&parked_id).unwrap(), "```Rust\naxb\n```\n");
        assert_eq!(store.read("old").unwrap(), SOURCE);
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
    panic!("bounded reservation interruption did not fire: {phase}");
}

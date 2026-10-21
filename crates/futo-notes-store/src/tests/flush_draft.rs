use super::*;

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

    let result = store
        .flush_draft("note", "base text", "draft text")
        .unwrap();

    assert_eq!(result.disposition, FlushDisposition::Wrote);
    let mutation = result.mutation.expect("a write projects a mutation");
    assert_eq!(mutation.final_id.as_deref(), Some("note"));
    assert_eq!(mutation.upserted[0].note.id, "note");
    assert_eq!(store.read("note").unwrap(), "draft text");
}

// `vault_mutation_guard` is ONE process-wide mutex, so every test in this
// binary queues on it. That makes a wall-clock budget for *reaching* the
// guarded span a measurement of queue depth rather than of `flush_draft`: on a
// loaded CI runner each guarded span costs a real fsync, and this test's flush
// thread waited seconds behind ~78 unrelated vaults (job 217730, "flush reached
// the guarded check/write span: Timeout"). So the arrival is observed from
// INSIDE the span, on the flush thread itself, and the only remaining deadline
// is the negative one — which contention can only make more likely to hold.
#[test]
fn flush_draft_serializes_its_check_and_write_against_sync_mutations() {
    let root = TestRoot::new();
    let store = Arc::new(store(&root));
    store.write("note", "base text", None).unwrap();

    // Parked until the flush hook releases it, so the simulated sync writer can
    // never take the vault guard BEFORE the flush owns its span.
    let sync_path = root.0.join("note.md");
    let (start_tx, start_rx) = mpsc::channel();
    let (attempting_tx, attempting_rx) = mpsc::channel();
    let (acquired_tx, acquired_rx) = mpsc::channel();
    let sync_write = std::thread::spawn(move || {
        start_rx.recv().unwrap();
        attempting_tx.send(()).unwrap();
        let _guard = futo_notes_core::files::vault_mutation_guard().unwrap();
        acquired_tx.send(()).unwrap();
        futo_notes_core::files::write_atomic_text(&sync_path, "peer text").unwrap();
    });

    // The receivers are shared rather than moved into the hook: the writer
    // signals `acquired` AFTER the span ends, so a receiver dropped when the
    // hook returns would turn that send into a panic.
    let attempting_rx = Arc::new(Mutex::new(attempting_rx));
    let acquired_rx = Arc::new(Mutex::new(acquired_rx));

    // `None` = the flush never reached the span; `Some(blocked)` = it did, and
    // whether the writer stayed out. The hook only RECORDS: a panic here would
    // unwind while holding the process-wide guard and poison it for every
    // remaining test in the binary.
    let observed = Arc::new(Mutex::new(None));
    let recorder = observed.clone();
    let attempting = attempting_rx.clone();
    let acquired = acquired_rx.clone();
    let start = Mutex::new(Some(start_tx));
    store.set_flush_window_hook(Box::new(move |_| {
        let Some(start_tx) = start.lock().unwrap().take() else {
            return;
        };
        if start_tx.send(()).is_err() || attempting.lock().unwrap().recv().is_err() {
            return;
        }
        *recorder.lock().unwrap() = Some(
            acquired
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_millis(75))
                .is_err(),
        );
    }));

    let flushing_store = store.clone();
    let flush = std::thread::spawn(move || {
        flushing_store
            .flush_draft("note", "base text", "draft text")
            .unwrap()
    });
    let result = flush.join().unwrap();

    assert_eq!(result.disposition, FlushDisposition::Wrote);
    assert_eq!(
        *observed.lock().unwrap(),
        Some(true),
        "sync must block while flush owns the check/write span"
    );
    sync_write.join().unwrap();
    assert_eq!(
        store.read("note").unwrap(),
        "peer text",
        "the later sync mutation wins instead of being clobbered by a stale flush"
    );
}

// The converged/park boundary: disk already holding the draft is an explicit
// outcome (shells never read disk to compare), and it must not rewrite
// identical bytes — an mtime bump would re-rank the note on every device.
#[test]
fn flush_draft_reports_convergence_without_rewriting_identical_bytes() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "same text", Some(1_000)).unwrap();

    let result = store
        .flush_draft("note", "stale base", "same text")
        .unwrap();

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

    let result = store
        .flush_draft("note", "original base", "my draft")
        .unwrap();

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
    assert_eq!(
        store.read("note").unwrap(),
        "peer version",
        "diverged note untouched"
    );
    assert_eq!(store.read(&expected_copy).unwrap(), "my draft");
}

#[test]
fn flush_draft_recreates_a_peer_deleted_note_at_the_original_id() {
    let root = TestRoot::new();
    let store = store(&root);

    let result = store
        .flush_draft("Gone", "old base", "surviving draft")
        .unwrap();

    assert_eq!(result.disposition, FlushDisposition::Recreated);
    assert_eq!(store.read("Gone").unwrap(), "surviving draft");
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
        store.read("Gone").unwrap(),
        "peer recreated",
        "the reappeared note must not be clobbered"
    );
    assert_eq!(store.read(&expected_copy).unwrap(), "my draft");
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

#[test]
fn editor_rename_preserves_peer_changes_and_parks_the_draft() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("Original", "peer edit", None).unwrap();
    let mutation = store
        .save_draft_as("Original", "Renamed", "base", "my draft")
        .unwrap();
    assert_eq!(store.read("Original").unwrap(), "peer edit");
    let final_id = mutation.final_id.unwrap();
    assert!(final_id.starts_with("Renamed (conflict "));
    assert_eq!(store.read(&final_id).unwrap(), "my draft");
    assert!(mutation.renamed.is_empty());
}

#[test]
fn editor_move_saves_and_relinks_in_one_workflow() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("Original", "base", None).unwrap();
    store.write("Link", "[[Original]]", None).unwrap();
    let mutation = store
        .save_draft_as("Original", "Folder/Original", "base", "my draft")
        .unwrap();
    assert_eq!(mutation.final_id.as_deref(), Some("Folder/Original"));
    assert!(!store.exists("Original"));
    assert_eq!(store.read("Folder/Original").unwrap(), "my draft");
    assert_eq!(store.read("Link").unwrap(), "[[Folder/Original]]");
}

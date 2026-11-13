use super::*;

// Park idempotency (the crash-window double-park, e.g. a scenePhase flush
// firing at both .inactive and .background): an identical draft parked twice
// mints ONE copy, and the second park still reports where it lives.
#[test]
fn parking_an_identical_draft_twice_mints_one_copy() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "peer version", None).unwrap();

    let first = store.flush_draft("note", "original", "my draft").unwrap();
    let second = store.flush_draft("note", "original", "my draft").unwrap();

    let expected_copy = format!("note (conflict {})", current_conflict_date());
    assert_eq!(
        first.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: expected_copy.clone()
        }
    );
    assert_eq!(
        second.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: expected_copy
        }
    );
    assert!(
        second.mutation.is_none(),
        "the second park must mint nothing"
    );
    assert_eq!(
        store.snapshot().notes.len(),
        2,
        "original + exactly one copy"
    );
}

// A genuinely different second draft is NOT the idempotent case — it gets its
// own copy through the naming rule's counter ("<stem> 2"), never a clobber of
// the first copy.
#[test]
fn each_distinct_diverged_draft_gets_its_own_counter_suffixed_copy() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "peer version", None).unwrap();

    store.flush_draft("note", "original", "draft one").unwrap();
    let second = store.flush_draft("note", "original", "draft two").unwrap();

    let date = current_conflict_date();
    assert_eq!(
        second.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: format!("note (conflict {date} 2)")
        }
    );
    assert_eq!(
        store.read(&format!("note (conflict {date})")).unwrap(),
        "draft one"
    );
    assert_eq!(
        store.read(&format!("note (conflict {date} 2)")).unwrap(),
        "draft two"
    );
}

// The idempotency guard matches only names this park could have minted — a
// similarly-named user note holding the same content must not swallow the
// park (the F1 class the recovered-backup guard already pins).
#[test]
fn the_park_guard_ignores_a_similarly_named_note_with_identical_content() {
    let root = TestRoot::new();
    let store = store(&root);
    let date = current_conflict_date();
    store.write("note", "peer version", None).unwrap();
    store
        .write(&format!("note (conflict {date}) draft"), "my draft", None)
        .unwrap();

    let result = store.flush_draft("note", "original", "my draft").unwrap();

    assert_eq!(
        result.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: format!("note (conflict {date})")
        }
    );
    assert_eq!(
        store.read(&format!("note (conflict {date})")).unwrap(),
        "my draft"
    );
}

// The engine's naming rule peels an existing conflict suffix instead of
// stacking a second one — parking a conflict copy yields a fresh dated copy.
#[test]
fn parking_a_conflict_copy_does_not_stack_suffixes() {
    let root = TestRoot::new();
    let store = store(&root);
    store
        .write("note (conflict 2026-01-01)", "peer version", None)
        .unwrap();

    let result = store
        .flush_draft("note (conflict 2026-01-01)", "original", "my draft")
        .unwrap();

    assert_eq!(
        result.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: format!("note (conflict {})", current_conflict_date())
        }
    );
}

// F4: the recreate arm must never install an id that cross-platform-collides
// (case-insensitive / NFC) with a DIFFERENT surviving note. `create_new_atomic`
// only catches an EXACT-path collision, so on a case-sensitive filesystem a
// peer-deleted draft at "Note" could otherwise shadow a live "note". The arm
// parks the draft at a non-shadowing id instead. (On a case-INSENSITIVE FS the
// two ids are one file: the missing-read never fires and the diverged arm parks
// anyway — so both filesystems land on ParkedConflict with no shadow.)
#[test]
fn flush_draft_recreate_parks_instead_of_shadowing_a_case_colliding_note() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "surviving peer", None).unwrap();

    let result = store.flush_draft("Note", "old base", "my draft").unwrap();

    let parked_id = match result.disposition {
        FlushDisposition::ParkedConflict { parked_id } => parked_id,
        other => panic!("expected the draft parked, not a shadow install: {other:?}"),
    };
    assert_eq!(
        store.read("note").unwrap(),
        "surviving peer",
        "the case-colliding sibling must be untouched"
    );
    assert_eq!(
        store.read(&parked_id).unwrap(),
        "my draft",
        "the draft survives as a non-shadowing conflict copy"
    );
}

// F4: the park mint loop must skip a candidate id that cross-platform-collides
// with a DIFFERENT live note. The first dated candidate "note (conflict DATE)"
// collides (case-only) with an existing "Note (conflict DATE)"; the loop must
// advance to the next counter variant rather than install a shadow that
// `create_new_atomic` can't detect on a case-sensitive filesystem.
#[test]
fn flush_draft_park_skips_a_case_colliding_conflict_id() {
    let root = TestRoot::new();
    let store = store(&root);
    let date = current_conflict_date();
    store.write("note", "peer version", None).unwrap();
    store
        .write(&format!("Note (conflict {date})"), "unrelated copy", None)
        .unwrap();

    let result = store
        .flush_draft("note", "original base", "my draft")
        .unwrap();

    let parked_id = match result.disposition {
        FlushDisposition::ParkedConflict { parked_id } => parked_id,
        other => panic!("expected a parked conflict copy: {other:?}"),
    };
    assert_eq!(
        parked_id,
        format!("note (conflict {date} 2)"),
        "the park must skip the case-colliding first candidate, not shadow it"
    );
    assert_eq!(store.read(&parked_id).unwrap(), "my draft");
    assert_eq!(
        store.read(&format!("Note (conflict {date})")).unwrap(),
        "unrelated copy",
        "the case-colliding sibling must be untouched"
    );
}

#[test]
fn flush_draft_parks_inside_the_notes_folder() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("Projects/note", "peer version", None).unwrap();

    let result = store
        .flush_draft("Projects/note", "original", "my draft")
        .unwrap();

    let expected_copy = format!("Projects/note (conflict {})", current_conflict_date());
    assert_eq!(
        result.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: expected_copy.clone()
        }
    );
    assert_eq!(store.read(&expected_copy).unwrap(), "my draft");
}

// A writer outside the store's serialization landing on the chosen copy name
// inside the park window fails the no-replace install; the retry re-runs the
// naming rule and both contents survive (the A1 window applied to parks).
#[test]
fn flush_draft_never_clobbers_a_concurrent_writer_at_the_parked_name() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "peer version", None).unwrap();
    store.set_install_window_hook(plant_once(&root, "peer at copy name"));

    let result = store.flush_draft("note", "original", "my draft").unwrap();

    let date = current_conflict_date();
    assert_eq!(
        result.disposition,
        FlushDisposition::ParkedConflict {
            parked_id: format!("note (conflict {date} 2)")
        }
    );
    assert_eq!(
        store.read(&format!("note (conflict {date})")).unwrap(),
        "peer at copy name",
        "the concurrent writer's copy must not be clobbered"
    );
    assert_eq!(
        store.read(&format!("note (conflict {date} 2)")).unwrap(),
        "my draft"
    );
}

mod support;
use futo_notes_ffi::{
    editor_find_scan, EditorByteRange, EditorDisplayMirror, EditorFindLanding, EditorUtf16Range,
    NoteStore,
};
use support::{path_string, TempTree};

#[test]
fn native_find_steps_scans_off_lock_and_never_touches_saves_or_history() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note(
            "f".into(),
            "".into(),
            "a **bo**ld Bold\r\n\r\nBOLD\r\n".into(),
        )
        .unwrap();
    let session = store.open_editor("f".into()).unwrap();

    let report = session.find_set_query(0, "bold".into()).unwrap();
    assert_eq!((report.total, report.current), (3, 1));
    assert_eq!(report.reveal, Some(EditorByteRange { start: 2, end: 6 }));
    let source = report.current_source.unwrap();
    assert_eq!(
        &session.source_text().unwrap()[source.start as usize..source.end as usize],
        "bo**ld"
    );
    let step = session.find_step(0, true).unwrap();
    assert_eq!(step.current, 2);
    assert_eq!(session.revision().unwrap(), 0);

    // Input costs no scan; the rescan runs from a snapshot and lands only for
    // the revision it was taken at.
    let before = session.find_scan_request().unwrap().unwrap();
    session
        .replace_utf16(
            0,
            EditorUtf16Range { start: 0, end: 0 },
            "x ".encode_utf16().collect(),
        )
        .unwrap();
    assert!(session.find_report().unwrap().stale);
    assert!(session
        .find_apply_scan(editor_find_scan(before).unwrap())
        .unwrap()
        .is_none());
    let request = session.find_scan_request().unwrap().unwrap();
    let report = session
        .find_apply_scan(editor_find_scan(request).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!((report.total, report.stale), (3, false));

    let closed = session.find_close().unwrap();
    assert_eq!((closed.open, closed.total), (false, 0));
    assert!(session.find_scan_request().unwrap().is_none());
    assert_eq!(
        session.source_text().unwrap(),
        "x a **bo**ld Bold\r\n\r\nBOLD\r\n"
    );
}

#[test]
fn find_snapshot_and_landing_give_utf16_marks_and_first_press_lands() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("g".into(), "".into(), "日本 **bo**ld bold\n".into())
        .unwrap();
    let session = store.open_editor("g".into()).unwrap();
    let mirror = EditorDisplayMirror::new(session.display_text().unwrap());
    let landing = EditorFindLanding::new();
    session.find_set_query(0, "bold".into()).unwrap();
    let snapshot = session
        .find_snapshot(0, mirror.clone(), false, true)
        .unwrap();
    let range = |start, end| EditorUtf16Range { start, end };
    assert_eq!(snapshot.matches, vec![range(3, 7), range(8, 12)]);
    assert_eq!(snapshot.reveal, Some(range(3, 7)));
    assert!(session
        .find_snapshot(0, mirror, true, true)
        .unwrap()
        .matches
        .is_empty());
    let first = session
        .find_step_landing(0, landing.clone(), true, false)
        .unwrap();
    assert_eq!((first.report.current, first.landing.is_some()), (1, true));
    let second = session
        .find_step_landing(0, landing.clone(), true, false)
        .unwrap();
    assert_eq!(second.report.current, 2);
    assert!(session
        .find_step_landing(0, landing, true, true)
        .unwrap()
        .landing
        .is_none());
}

#[test]
fn a_first_press_after_an_edit_dropped_the_current_match_steps_to_a_match() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("h".into(), "".into(), "cat\n\ncat\n\ncat\n".into())
        .unwrap();
    let session = store.open_editor("h".into()).unwrap();
    let landing = EditorFindLanding::new();
    session.find_set_query(0, "cat".into()).unwrap();
    // Typing inside the current match drops it until a rescan, leaving two matches and no current.
    session
        .replace_utf16(
            0,
            EditorUtf16Range { start: 1, end: 2 },
            "x".encode_utf16().collect(),
        )
        .unwrap();
    let report = session.find_report().unwrap();
    assert_eq!((report.total, report.current), (2, 0));
    let press = session
        .find_step_landing(1, landing.clone(), true, false)
        .unwrap();
    assert_eq!(press.landing, Some(EditorByteRange { start: 5, end: 8 }));
    assert_eq!(press.report.current, 1);
    let next = session.find_step_landing(1, landing, true, false).unwrap();
    assert_eq!(next.report.current, 2);
}

#[test]
fn a_press_after_a_rescan_replaced_the_dropped_current_match_lands_on_it() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("i".into(), "".into(), "cat\n\ncat\n\ncat\n\ncat\n".into())
        .unwrap();
    let session = store.open_editor("i".into()).unwrap();
    let landing = EditorFindLanding::new();
    session.find_set_query(0, "cat".into()).unwrap();
    session
        .find_step_landing(0, landing.clone(), true, false)
        .unwrap();
    let second = session
        .find_step_landing(0, landing.clone(), true, false)
        .unwrap();
    assert_eq!(second.landing, Some(EditorByteRange { start: 5, end: 8 }));
    session
        .replace_utf16(
            0,
            EditorUtf16Range { start: 6, end: 7 },
            "x".encode_utf16().collect(),
        )
        .unwrap();
    let request = session.find_scan_request().unwrap().unwrap();
    session
        .find_apply_scan(editor_find_scan(request).unwrap())
        .unwrap()
        .unwrap();
    // The rescan chose 10..13; no press took the user there, so Next lands on it.
    let press = session.find_step_landing(1, landing, true, false).unwrap();
    assert_eq!(press.landing, Some(EditorByteRange { start: 10, end: 13 }));
}

#[test]
fn previous_after_a_rescan_replaced_the_dropped_current_match_steps_before_it() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("j".into(), "".into(), "cat\n\ncat\n\ncat\n\ncat\n".into())
        .unwrap();
    let session = store.open_editor("j".into()).unwrap();
    let landing = EditorFindLanding::new();
    session.find_set_query(0, "cat".into()).unwrap();
    session
        .find_step_landing(0, landing.clone(), true, false)
        .unwrap();
    let second = session
        .find_step_landing(0, landing.clone(), true, false)
        .unwrap();
    assert_eq!(second.landing, Some(EditorByteRange { start: 5, end: 8 }));
    session
        .replace_utf16(
            0,
            EditorUtf16Range { start: 6, end: 7 },
            "x".encode_utf16().collect(),
        )
        .unwrap();
    let request = session.find_scan_request().unwrap().unwrap();
    session
        .find_apply_scan(editor_find_scan(request).unwrap())
        .unwrap()
        .unwrap();
    // The rescan chose 10..13, but Previous goes to the match before where the user was.
    let press = session.find_step_landing(1, landing, false, false).unwrap();
    assert_eq!(press.landing, Some(EditorByteRange { start: 0, end: 3 }));
}

#[test]
fn the_first_press_after_a_query_change_lands_even_after_a_seen_drop() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("k".into(), "".into(), "cat\n\ncat\n\ncat\n\ncat\n".into())
        .unwrap();
    let session = store.open_editor("k".into()).unwrap();
    let landing = EditorFindLanding::new();
    session.find_set_query(0, "cat".into()).unwrap();
    for _ in 0..2 {
        session
            .find_step_landing(0, landing.clone(), true, false)
            .unwrap();
    }
    session
        .replace_utf16(
            0,
            EditorUtf16Range { start: 6, end: 7 },
            "x".encode_utf16().collect(),
        )
        .unwrap();
    session.find_report().unwrap(); // the debounced refresh reads the drop
    landing.reset();
    session.find_set_query(1, "cat".into()).unwrap();
    // The new query's current match is 10..13: the first press lands on it, either direction.
    let press = session.find_step_landing(1, landing, false, false).unwrap();
    assert_eq!(press.landing, Some(EditorByteRange { start: 10, end: 13 }));
}

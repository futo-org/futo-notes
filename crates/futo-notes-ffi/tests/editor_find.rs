mod support;
use futo_notes_ffi::{editor_find_scan, EditorByteRange, EditorUtf16Range, NoteStore};
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

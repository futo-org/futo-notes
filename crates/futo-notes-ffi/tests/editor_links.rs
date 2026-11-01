mod support;
use futo_notes_ffi::{
    EditorAffinity, EditorByteRange, EditorSessionError, EditorUtf16Range, NoteStore,
};
use support::{path_string, TempTree};

#[test]
fn native_link_commands_and_corrections_recover_exact_source_and_destinations() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let path = path_string(&tree.path("vault"));
    let store = NoteStore::new(path.clone());
    let original = "see [teh __docs__](https://old.test 'Title')\r\n";
    store
        .create_note("links".into(), "".into(), original.into())
        .unwrap();
    let session = store.open_editor("links".into()).unwrap();
    let mut display = "see teh docs\r\n".to_owned();
    let change = session
        .replace_utf16(
            0,
            EditorUtf16Range { start: 4, end: 7 },
            "the".encode_utf16().collect(),
        )
        .unwrap();
    display.replace_range(
        change.range.start as usize..change.range.end as usize,
        &change.inserted,
    );
    assert_eq!(display, "see the docs\r\n");
    let link = session
        .inspect_link(1, EditorByteRange { start: 5, end: 6 })
        .unwrap()
        .unwrap();
    assert_eq!(link.range, EditorByteRange { start: 4, end: 12 });
    assert_eq!(link.destination, "https://old.test");
    let change = session
        .set_link(
            1,
            EditorByteRange { start: 5, end: 6 },
            "https://x.test".into(),
        )
        .unwrap()
        .unwrap();
    display.replace_range(
        change.range.start as usize..change.range.end as usize,
        &change.inserted,
    );
    let updated = "see [the __docs__](https://x.test 'Title')\r\n";
    assert_eq!(session.source_text().unwrap(), updated);
    assert_eq!(display, "see the docs\r\n");
    session.undo(2).unwrap().unwrap();
    assert_eq!(
        session.source_text().unwrap(),
        "see [the __docs__](https://old.test 'Title')\r\n"
    );
    session.redo(3).unwrap().unwrap();
    session.flush_recovery().unwrap();
    drop(session);
    drop(store);
    let store = NoteStore::new(path);
    let session = store.open_editor("links".into()).unwrap();
    assert_eq!(session.source_text().unwrap(), updated);
    let projection = session
        .project(4, EditorByteRange { start: 0, end: 14 })
        .unwrap();
    assert_eq!(projection.text, "see the docs\r\n");
    assert_eq!(projection.links[0].destination, "https://x.test");
    session.checkpoint().unwrap();
    assert_eq!(store.read("links".into()).unwrap(), updated);
}

#[test]
fn native_note_id_refresh_reaches_a_composing_session() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("Roadmap".into(), "Projects".into(), "".into())
        .unwrap();
    store
        .create_note("home".into(), "".into(), "[[Roadmap]] ab".into())
        .unwrap();
    let session = store.open_editor("home".into()).unwrap();
    session
        .compose_utf16(0, EditorUtf16Range { start: 14, end: 14 }, vec![0x304b])
        .unwrap();
    // The store delivered ids at open; a vault change arrives through refresh.
    assert!(session.refresh_note_ids().unwrap().projections.is_empty());
    store
        .create_note("Roadmap".into(), "Archive".into(), "".into())
        .unwrap();
    let change = session.refresh_note_ids().unwrap();
    assert_eq!(change.revision, 0);
    assert_eq!(change.projections.len(), 1);
    assert_eq!(change.projections[0].wikilinks[0].note_id, None);
    let link = &session
        .project(0, EditorByteRange { start: 0, end: 11 })
        .unwrap()
        .wikilinks[0];
    assert_eq!(link.range, EditorByteRange { start: 0, end: 11 });
    assert_eq!(
        (link.label.as_str(), link.note_id.as_deref()),
        ("Roadmap", None)
    );
    assert_eq!(session.source_text().unwrap(), "[[Roadmap]] ab");
}

#[test]
fn native_wikilink_completion_requests_accepts_and_rejects_stale_claims() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("Roadmap".into(), "Projects".into(), "".into())
        .unwrap();
    store
        .create_note("home".into(), "".into(), "see [[Ro".into())
        .unwrap();
    let session = store.open_editor("home".into()).unwrap();
    let at = EditorByteRange { start: 8, end: 8 };
    session
        .select_with_affinity(0, at, EditorAffinity::Forward)
        .unwrap();
    let found = session.wikilink_completion(0).unwrap().unwrap();
    assert_eq!(found.range, EditorByteRange { start: 4, end: 8 });
    assert_eq!(found.query, "Ro");
    assert_eq!(found.candidates.len(), 1);
    assert_eq!(found.candidates[0].label, "Roadmap");
    assert_eq!(
        found.candidates[0].detail.as_deref(),
        Some("Projects/Roadmap")
    );
    assert!(matches!(
        session.accept_wikilink_completion(0, found.range, "R".into(), "Projects/Roadmap".into()),
        Err(EditorSessionError::StaleCompletion)
    ));
    let change = session
        .accept_wikilink_completion(
            0,
            found.range,
            found.query.clone(),
            "Projects/Roadmap".into(),
        )
        .unwrap();
    assert_eq!(change.revision, 1);
    assert_eq!(session.source_text().unwrap(), "see [[Projects/Roadmap]]");
    assert!(matches!(
        session.accept_wikilink_completion(0, found.range, found.query, "Projects/Roadmap".into()),
        Err(EditorSessionError::StaleRevision { .. })
    ));
    session.checkpoint().unwrap();
    assert_eq!(
        store.read("home".into()).unwrap(),
        "see [[Projects/Roadmap]]"
    );
}

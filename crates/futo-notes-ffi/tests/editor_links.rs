mod support;
use futo_notes_ffi::{
    EditorAffinity, EditorByteRange, EditorSessionError, EditorUtf16Range, NoteStore,
};
use support::{path_string, TempTree};

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
        Err(EditorSessionError::StaleClaim)
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

/// The engine, not the shell, unwraps `<...>` destinations and decides what is fetchable.
#[test]
fn native_image_atoms_classify_destinations_once() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    let source = "![a](<https://x.test/a.png>) ![b](http://x.test/b.png) ![c](<my pic.png>) ![d](data:image/png;base64,AAAA)";
    store
        .create_note("mix".into(), "".into(), source.into())
        .unwrap();
    let session = store.open_editor("mix".into()).unwrap();
    let atoms = session
        .project(
            0,
            EditorByteRange {
                start: 0,
                end: source.len() as u64,
            },
        )
        .unwrap()
        .atoms;
    let described: Vec<_> = atoms
        .iter()
        .map(|atom| {
            let image = atom.image.as_ref().unwrap();
            (image.destination.as_str(), image.vault, image.remote)
        })
        .collect();
    assert_eq!(
        described,
        vec![
            ("https://x.test/a.png", false, true),
            ("http://x.test/b.png", false, true),
            ("my pic.png", true, false),
            ("data:image/png;base64,AAAA", false, false),
        ]
    );
}

#[test]
fn native_atoms_and_image_insertion_reject_claims_from_a_reopened_session() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("pics".into(), "".into(), "a ![x](image-1.png) b".into())
        .unwrap();
    let session = store.open_editor("pics".into()).unwrap();
    let atoms = session
        .project(0, EditorByteRange { start: 0, end: 21 })
        .unwrap()
        .atoms;
    assert_eq!(atoms.len(), 1);
    assert_eq!(atoms[0].range, EditorByteRange { start: 2, end: 19 });
    assert_eq!((atoms[0].before, atoms[0].after), (2, 19));
    let image = atoms[0].image.as_ref().unwrap();
    assert_eq!(
        (image.alt.as_str(), image.destination.as_str()),
        ("x", "image-1.png")
    );
    assert!(image.vault);
    assert!(!image.remote);

    let claim = session.image_claim().unwrap();
    session
        .select_with_affinity(
            0,
            EditorByteRange { start: 21, end: 21 },
            EditorAffinity::Forward,
        )
        .unwrap();
    session
        .insert_image(0, claim, "image-2.png".into(), "".into())
        .unwrap()
        .unwrap();
    assert_eq!(
        session.source_text().unwrap(),
        "a ![x](image-1.png) b![](image-2.png)"
    );
    session.checkpoint().unwrap();
    drop(session);
    let reopened = store.open_editor("pics".into()).unwrap();
    assert!(matches!(
        reopened.insert_image(0, claim, "image-3.png".into(), "".into()),
        Err(EditorSessionError::StaleClaim)
    ));
}

#[test]
fn native_edit_link_is_atomic_revision_bound_and_durable() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("links".into(), "".into(), "see  tail".into())
        .unwrap();
    let session = store.open_editor("links".into()).unwrap();
    let at = EditorByteRange { start: 4, end: 4 };
    session
        .select_with_affinity(0, at, EditorAffinity::Forward)
        .unwrap();
    session
        .edit_link(0, at, "雪 [x]".into(), "/new".into())
        .unwrap()
        .unwrap();
    let linked = session.source_text().unwrap();
    assert_eq!(session.display_text().unwrap(), "see 雪 [x] tail");
    assert!(matches!(
        session.edit_link(0, at, "bad".into(), "/bad".into()),
        Err(EditorSessionError::StaleRevision { .. })
    ));
    session.undo(1).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), "see  tail");
    session.redo(2).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), linked);
    session.checkpoint().unwrap();
    drop(session);
    let reopened = store.open_editor("links".into()).unwrap();
    assert_eq!(reopened.source_text().unwrap(), linked);
    assert_eq!(
        reopened
            .inspect_link(0, EditorByteRange { start: 4, end: 7 })
            .unwrap()
            .unwrap()
            .destination,
        "/new"
    );
}

#[test]
fn native_unchanged_labels_over_lines_link_each_line_with_history_and_saved_line_endings() {
    for ending in ["\n", "\r\n"] {
        let tree = TempTree::new();
        std::fs::create_dir_all(tree.path("vault")).unwrap();
        let store = NoteStore::new(path_string(&tree.path("vault")));
        let source = format!("alpha{ending}beta{ending}");
        store
            .create_note("links".into(), "".into(), source.clone())
            .unwrap();
        let session = store.open_editor("links".into()).unwrap();
        let label = format!("alpha{ending}bet");
        let target = EditorByteRange {
            start: 0,
            end: label.len() as u64,
        };
        session
            .select_with_affinity(0, target, EditorAffinity::Forward)
            .unwrap();
        session
            .edit_link(0, target, label, "/new".into())
            .unwrap()
            .unwrap();
        // A link never crosses a line: each line's text is linked.
        let edited = format!("[alpha](/new){ending}[bet](/new)a{ending}");
        assert_eq!(session.source_text().unwrap(), edited);
        assert_eq!(session.display_text().unwrap(), source);
        let undo = session.undo(1).unwrap().unwrap();
        assert_eq!(undo.selection, target);
        assert_eq!(session.source_text().unwrap(), source);
        session.redo(2).unwrap().unwrap();
        assert_eq!(session.source_text().unwrap(), edited);
        session.checkpoint().unwrap();
        drop(session);
        let reopened = store.open_editor("links".into()).unwrap();
        assert_eq!(reopened.source_text().unwrap(), edited);
        assert_eq!(
            reopened
                .inspect_link(0, EditorByteRange { start: 0, end: 5 })
                .unwrap()
                .unwrap()
                .destination,
            "/new"
        );
        assert!(reopened.undo(0).unwrap().is_none());
    }
}

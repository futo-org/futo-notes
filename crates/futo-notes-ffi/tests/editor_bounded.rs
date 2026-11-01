mod support;
use futo_notes_ffi::{EditorInputAction, EditorSessionError, EditorUtf16Range, NoteStore};
use support::{path_string, TempTree};

#[test]
fn consuming_native_bounded_transfer_keeps_the_exact_owner_history_and_lease() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    let source = "```Rust\nab\n```\n\n__😀__ &acE; [x](u)\n\n";
    store
        .create_note("plain".into(), "".into(), source.into())
        .unwrap();
    let full = store.open_editor("plain".into()).unwrap();
    // A live recovery stream also exercises this boundary on filesystems where
    // fresh no-copy preparation is explicitly unsupported.
    full.replace_utf16_action(
        0,
        EditorUtf16Range { start: 1, end: 1 },
        vec![120],
        EditorInputAction::Isolated,
    )
    .unwrap();
    let alias = full.clone();
    let bounded = full.into_bounded(1, 81, 1).unwrap();
    assert!(matches!(
        alias.source_text(),
        Err(EditorSessionError::Unavailable)
    ));
    assert!(matches!(
        store.open_editor("plain".into()),
        Err(EditorSessionError::SessionAlreadyOpen)
    ));
    let before = bounded.cursor().unwrap();
    let changed = bounded.insert_literal(before, 2, u32::from('😀')).unwrap();
    assert_eq!(changed.previous, before);
    assert_eq!(changed.cursor.revision, 2);
    assert_eq!(changed.inserted, "😀");
    assert_eq!(changed.source_change.inserted_bytes, 4);
    assert_eq!(changed.projection.identity.source.start, 10);
    assert!(changed.conversion.records > 0);
    let bounded_alias = bounded.clone();
    let handoff = bounded.into_full().unwrap();
    assert!(matches!(
        bounded_alias.cursor(),
        Err(futo_notes_ffi::EditorBoundedError::Unavailable)
    ));
    assert_eq!(
        handoff.session.source_text().unwrap(),
        "```Rust\nax😀b\n```\n\n__😀__ &acE; [x](u)\n\n"
    );
    handoff.session.undo(2).unwrap().unwrap();
    assert_eq!(
        handoff.session.source_text().unwrap(),
        "```Rust\naxb\n```\n\n__😀__ &acE; [x](u)\n\n"
    );
    handoff.session.undo(3).unwrap().unwrap();
    assert_eq!(handoff.session.source_text().unwrap(), source);
    handoff.session.detach().unwrap();
    assert_eq!(
        store
            .open_editor("plain".into())
            .unwrap()
            .source_text()
            .unwrap(),
        source
    );
}

#[test]
fn refused_native_entry_restores_composition_history_and_the_original_alias() {
    use futo_notes_ffi::EditorBoundedError;
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    let source = "```Rust\nab\n```\n";
    store
        .create_note("plain".into(), "".into(), source.into())
        .unwrap();
    let full = store.open_editor("plain".into()).unwrap();
    full.replace_utf16(0, EditorUtf16Range { start: 1, end: 1 }, vec![120])
        .unwrap();
    full.compose_utf16(1, EditorUtf16Range { start: 2, end: 2 }, vec![109])
        .unwrap();
    let alias = full.clone();
    assert!(matches!(
        full.into_bounded(1, 82, 1),
        Err(EditorBoundedError::Session {
            error: EditorSessionError::CompositionActive
        })
    ));
    assert_eq!(alias.source_text().unwrap(), "```Rust\naxb\n```\n");
    assert_eq!(alias.composition().unwrap().unwrap().text, "m");
    assert!(matches!(
        store.open_editor("plain".into()),
        Err(EditorSessionError::SessionAlreadyOpen)
    ));
    alias.cancel_composition(1).unwrap();
    let bounded = alias.into_bounded(1, 82, 1).unwrap();
    let full = bounded.into_full().unwrap().session;
    full.undo(1).unwrap().unwrap();
    assert_eq!(full.source_text().unwrap(), source);
}

#[test]
fn bounded_native_fixed_width_input_rejects_invalid_scalars_ranges_and_stale_authority() {
    use futo_notes_ffi::EditorBoundedError;
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("plain".into(), "".into(), "```\na😀b\n```\n".into())
        .unwrap();
    let full = store.open_editor("plain".into()).unwrap();
    full.replace_utf16(0, EditorUtf16Range { start: 0, end: 0 }, vec![120])
        .unwrap();
    let bounded = full.into_bounded(1, 83, 0).unwrap();
    let cursor = bounded.cursor().unwrap();
    for scalar in [0xd800, 0x110000] {
        assert!(matches!(
            bounded.insert_literal(cursor, 0, scalar),
            Err(EditorBoundedError::InvalidScalar)
        ));
        assert_eq!(
            bounded.last_operation_work().unwrap().work,
            Default::default()
        );
    }
    for at in [3, u64::MAX, 0x100000000] {
        assert!(matches!(
            bounded.insert_literal(cursor, at, 65),
            Err(EditorBoundedError::Session {
                error: EditorSessionError::InvalidRange
            })
        ));
        assert_eq!(
            bounded.last_operation_work().unwrap().work,
            Default::default()
        );
    }
    assert!(matches!(
        bounded.insert_literal(cursor, 0, 10),
        Err(EditorBoundedError::Unsupported)
    ));
    assert_eq!(bounded.cursor().unwrap(), cursor);
    assert_eq!(
        bounded.accepted_source().unwrap().source,
        "```\nxa😀b\n```\n"
    );
    let mut foreign = cursor;
    foreign.token += 1;
    assert!(matches!(
        bounded.insert_literal(foreign, u64::MAX, 0xd800),
        Err(EditorBoundedError::StaleCursor)
    ));
    foreign = cursor;
    foreign.incarnation += 1;
    assert!(matches!(
        bounded.insert_literal(foreign, 0, 65),
        Err(EditorBoundedError::StaleCursor)
    ));
    let changed = bounded.insert_literal(cursor, 1, 65).unwrap();
    assert_eq!(bounded.last_operation_work().unwrap().work, changed.work);
    assert!(matches!(
        bounded.insert_literal(cursor, 1, 65),
        Err(EditorBoundedError::StaleCursor)
    ));
    assert_eq!(
        bounded.last_operation_work().unwrap().work,
        Default::default()
    );
    assert_eq!(changed.cursor.revision, 2);
    assert!(bounded.recovery_flush_delay().unwrap().is_some());
    assert_eq!(bounded.flush_recovery().unwrap().durable, 2);
    assert_eq!(bounded.recovery_flush_delay().unwrap(), None);
    assert!(!bounded.resume_recovery().unwrap().paused);
    bounded.detach().unwrap();
    assert!(matches!(
        bounded.cursor(),
        Err(EditorBoundedError::Unavailable)
    ));
    assert_eq!(
        store
            .open_editor("plain".into())
            .unwrap()
            .source_text()
            .unwrap(),
        "```\nxAa😀b\n```\n"
    );
}

#[test]
fn bounded_native_reset_and_terminal_copy_keep_source_revision_separate_from_watermarks() {
    use futo_notes_ffi::EditorBoundedError;
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("plain".into(), "".into(), "```\nab\n```\n".into())
        .unwrap();
    let full = store.open_editor("plain".into()).unwrap();
    full.replace_utf16(0, EditorUtf16Range { start: 0, end: 0 }, vec![120])
        .unwrap();
    let bounded = full.into_bounded(1, 84, 0).unwrap();
    let old = bounded.cursor().unwrap();
    store.rename("plain".into(), "renamed".into()).unwrap();
    assert!(bounded.reset_required().unwrap());
    assert!(matches!(
        bounded.insert_literal(old, 0, 65),
        Err(EditorBoundedError::ModeResetRequired)
    ));
    let copy = bounded.accepted_source().unwrap();
    assert_eq!(copy.source, "```\nxab\n```\n");
    assert_eq!(copy.revision, 1);
    assert!(copy.reset_required && !copy.deleted);
    assert_eq!(copy.conversion.copied_text_bytes, copy.source.len() as u64);
    let full = bounded.into_full().unwrap().session;
    assert_eq!(full.note_id().unwrap(), "renamed");
    full.undo(1).unwrap().unwrap();
    let bounded = full.into_bounded(2, 85, 0).unwrap();
    store.delete("renamed".into()).unwrap();
    store
        .create_note("renamed".into(), "".into(), "fresh".into())
        .unwrap();
    assert!(matches!(
        bounded.cursor(),
        Err(EditorBoundedError::Session {
            error: EditorSessionError::SessionDeleted
        })
    ));
    assert!(matches!(
        bounded.into_full(),
        Err(EditorBoundedError::Session {
            error: EditorSessionError::SessionDeleted
        })
    ));
    let copy = bounded.accepted_source().unwrap();
    assert!(copy.deleted);
    assert_eq!(copy.source, "```\nab\n```\n");
    assert_eq!(copy.revision, 2);
    bounded.detach().unwrap();
    assert_eq!(
        store
            .open_editor("renamed".into())
            .unwrap()
            .source_text()
            .unwrap(),
        "fresh"
    );
}

#[test]
fn refused_native_entry_keeps_spent_work_on_the_restored_full_owner() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("plain".into(), "".into(), "plain\n".into())
        .unwrap();
    let full = store.open_editor("plain".into()).unwrap();
    full.replace_utf16(0, EditorUtf16Range { start: 0, end: 0 }, vec![120])
        .unwrap();
    let alias = full.clone();
    assert!(matches!(
        full.into_bounded(1, 89, 0),
        Err(futo_notes_ffi::EditorBoundedError::Unsupported)
    ));
    let receipt = alias.last_bounded_operation_work().unwrap();
    assert!(receipt.work.metadata_items > 0);
    assert_eq!(receipt, full.last_bounded_operation_work().unwrap());
    assert_eq!(full.source_text().unwrap(), "xplain\n");
    assert!(full.into_bounded(0, 89, 0).is_err());
    assert_eq!(
        full.last_bounded_operation_work().unwrap().work,
        Default::default()
    );
    full.undo(1).unwrap().unwrap();
    assert_eq!(alias.source_text().unwrap(), "plain\n");
}

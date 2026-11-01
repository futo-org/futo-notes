mod support;
use futo_notes_ffi::*;
use support::{path_string, TempTree};

fn apply(view: &mut Vec<u8>, range: EditorByteRange, inserted: &str) {
    view.splice(
        usize::try_from(range.start).unwrap()..usize::try_from(range.end).unwrap(),
        inserted.bytes(),
    );
}
fn progress(
    view: &mut Vec<u8>,
    frame: EditorBoundedProgress,
) -> Option<EditorProjectionContinuation> {
    match frame {
        EditorBoundedProgress::Change { change } => {
            apply(view, change.range, &change.inserted);
            assert!(change.work.parsed_source_bytes == 0);
            assert!(change.work.returned_records <= 512);
            assert!(change.conversion.records > 0);
            change.continuation
        }
        EditorBoundedProgress::Status { status } => status.continuation,
    }
}
fn finish(
    session: &NativeBoundedEditorSession,
    view: &mut Vec<u8>,
    mut job: Option<EditorProjectionContinuation>,
) {
    let mut steps = 0;
    while let Some(next) = job {
        let before = session.cursor().unwrap();
        job = progress(view, session.continue_projection(next).unwrap());
        assert_eq!(session.cursor().unwrap().revision, before.revision);
        steps += 1;
        assert!(steps < 32, "finite paragraph frontier must finish");
    }
}

#[test]
fn native_bounded_pending_input_history_and_complete_semantic_maps_survive_full_handoff() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    let paragraph = "__😀__ &acE; [x](u) plain\n\n";
    let source = format!("prefix\n\n```Rust\nab\n```\n\n{}", paragraph.repeat(8));
    store
        .create_note("plain".into(), "".into(), source.clone())
        .unwrap();
    let full = store.open_editor("plain".into()).unwrap();
    full.replace_utf16(0, EditorUtf16Range { start: 8, end: 8 }, vec![122])
        .unwrap();
    let mut view = full.display_text().unwrap().into_bytes();
    let bounded = full.into_bounded(1, 86, 8).unwrap();
    assert!(bounded.preparation_work().unwrap().work.metadata_items > 0);
    let change = bounded
        .remove_fence_closer(bounded.cursor().unwrap())
        .unwrap();
    apply(&mut view, change.range, &change.inserted);
    let stale = change.continuation.unwrap();
    let at = String::from_utf8(view.clone())
        .unwrap()
        .rfind("plain")
        .unwrap() as u64
        + 2;
    let before_selection = bounded.cursor().unwrap();
    let selected = bounded
        .select_bounded(
            bounded.cursor().unwrap(),
            EditorByteRange { start: at, end: at },
            EditorAffinity::Backward,
        )
        .unwrap();
    match &selected {
        EditorBoundedProgress::Change { change } => {
            assert_eq!(change.affinity, EditorAffinity::Backward)
        }
        EditorBoundedProgress::Status { status } => {
            assert_eq!(status.affinity, EditorAffinity::Backward)
        }
    }
    progress(&mut view, selected);
    let after_selection = bounded.cursor().unwrap();
    assert_eq!(before_selection.revision, after_selection.revision);
    assert!(after_selection.generation > before_selection.generation);
    assert!(matches!(
        bounded.continue_projection(stale),
        Err(EditorBoundedError::StaleCursor)
    ));
    let change = bounded
        .insert_prefix_literal(bounded.cursor().unwrap(), 1, 113)
        .unwrap();
    apply(&mut view, change.range, &change.inserted);
    assert_eq!(
        change.source_change.unwrap().range,
        EditorSourceByteRange { start: 1, end: 1 }
    );
    let code = bounded
        .insert_literal(bounded.cursor().unwrap(), 10, u32::from('😀'))
        .unwrap();
    assert_eq!(code.projection.block.owner, 9);
    assert_eq!(code.selection, EditorByteRange { start: 14, end: 14 });
    assert_eq!(code.affinity, EditorAffinity::Backward);
    assert_eq!(
        code.projection.identity.source,
        EditorSourceByteRange { start: 18, end: 22 }
    );
    apply(&mut view, code.range, &code.inserted);
    finish(&bounded, &mut view, code.continuation);
    let expected = format!("pqrefix\n\n```Rust\nz😀ab\n\n\n{}", paragraph.repeat(8));
    assert_eq!(bounded.accepted_source().unwrap().source, expected);
    let mut job = None;
    for _ in 0..3 {
        job = progress(
            &mut view,
            bounded
                .undo_bounded(bounded.cursor().unwrap())
                .unwrap()
                .unwrap(),
        );
    }
    let mut atom = false;
    let mut hidden = false;
    let mut link = false;
    let mut steps = 0;
    while let Some(next) = job {
        let frame = bounded.continue_projection(next).unwrap();
        if let EditorBoundedProgress::Change { change } = &frame {
            atom |= change.projection.mapping.iter().any(|map| {
                map.kind == EditorBoundedMapKind::Atom
                    && map.source.end - map.source.start == 5
                    && map.display.end - map.display.start == 5
            });
            hidden |= change
                .projection
                .mapping
                .iter()
                .any(|map| map.kind == EditorBoundedMapKind::Hidden);
            link |= change
                .projection
                .links
                .iter()
                .any(|item| item.destination == "u");
        }
        job = progress(&mut view, frame);
        steps += 1;
        assert!(steps < 32);
    }
    assert!(
        atom && hidden && link,
        "restoration carries atom/hidden/link witnesses"
    );
    for _ in 0..3 {
        job = progress(
            &mut view,
            bounded
                .redo_bounded(bounded.cursor().unwrap())
                .unwrap()
                .unwrap(),
        );
    }
    finish(&bounded, &mut view, job);
    let before = bounded.cursor().unwrap();
    let handoff = bounded.into_full().unwrap();
    assert_eq!(handoff.session.revision().unwrap(), before.revision);
    assert_eq!(handoff.session.source_text().unwrap(), expected);
    assert_eq!(handoff.session.display_text().unwrap().as_bytes(), view);
    let direct = futo_notes_editor::EditorSession::open(&expected);
    let range = EditorByteRange {
        start: 0,
        end: view.len() as u64,
    };
    let mut actual = handoff.session.project(before.revision, range).unwrap();
    actual.revision = 0;
    let expected_projection: EditorProjection = direct
        .project(futo_notes_editor::Revision(0), range.try_into().unwrap())
        .unwrap()
        .into();
    assert_eq!(
        actual, expected_projection,
        "complete canonical source correspondence, atoms, blocks, links and formats"
    );
    for _ in 0..4 {
        handoff
            .session
            .undo(handoff.session.revision().unwrap())
            .unwrap()
            .unwrap();
    }
    assert_eq!(handoff.session.source_text().unwrap(), source);
}

#[test]
fn clean_preparation_refusal_or_failed_materialization_retains_original_owner() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("plain".into(), "".into(), "```\nab\n```\n".into())
        .unwrap();
    let full = store.open_editor("plain".into()).unwrap();
    let bounded = match full.into_bounded(0, 87, 0) {
        Ok(session) => session,
        Err(EditorBoundedError::Session {
            error: EditorSessionError::Recovery { error },
        }) => {
            // A no-copy filesystem capability is optional. This branch proves
            // rollback; the other public traces use an existing live log.
            assert_eq!(full.source_text().unwrap(), "```\nab\n```\n");
            println!(
                "NATIVE_BOUNDED_PREPARATION_REFUSED: {error}; fresh cleanup branch not executed"
            );
            full.replace_utf16(0, EditorUtf16Range { start: 1, end: 1 }, vec![120])
                .unwrap();
            let bounded = full.into_bounded(1, 87, 1).unwrap();
            assert_eq!(bounded.accepted_source().unwrap().source, "```\naxb\n```\n");
            let full = bounded.into_full().unwrap().session;
            full.undo(1).unwrap().unwrap();
            assert_eq!(full.source_text().unwrap(), "```\nab\n```\n");
            return;
        }
        Err(error) => panic!("unexpected preparation failure: {error}"),
    };
    let path = std::fs::read_dir(tree.path("vault/.futo-editor-recovery"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().is_some_and(|ext| ext == "prepared"))
        .unwrap();
    let owned = path.with_extension("owned");
    std::fs::rename(&path, &owned).unwrap();
    std::fs::write(&path, b"foreign").unwrap();
    let cursor = bounded.cursor().unwrap();
    assert!(matches!(
        bounded.into_full(),
        Err(EditorBoundedError::Session {
            error: EditorSessionError::Recovery { .. }
        })
    ));
    assert_eq!(bounded.cursor().unwrap(), cursor);
    assert!(!bounded.reset_required().unwrap());
    assert_eq!(bounded.accepted_source().unwrap().source, "```\nab\n```\n");
    assert_eq!(std::fs::read(&path).unwrap(), b"foreign");
    assert!(matches!(
        store.open_editor("plain".into()),
        Err(EditorSessionError::SessionAlreadyOpen)
    ));
    let rejected_raw = u32::from('x');
    assert!(matches!(
        bounded.insert_literal(cursor, 1, rejected_raw),
        Err(EditorBoundedError::Session {
            error: EditorSessionError::RecoveryAppend { .. }
        })
    ));
    let copy = bounded.accepted_source().unwrap();
    assert!(bounded.last_operation_work().unwrap().work.copied_bytes > 0);
    assert_eq!(copy.source, "```\nab\n```\n");
    assert_eq!(copy.revision, 0);
    assert!(copy.recovery.paused);
    assert_eq!(bounded.cursor().unwrap(), cursor);
    assert!(matches!(
        bounded.resume_recovery(),
        Err(EditorBoundedError::Session {
            error: EditorSessionError::RecoveryResume { .. }
        })
    ));
    std::fs::remove_file(&path).unwrap(); // Only this test's foreign fixture.
    std::fs::rename(&owned, &path).unwrap();
    assert!(!bounded.resume_recovery().unwrap().paused);
    bounded.insert_literal(cursor, 1, rejected_raw).unwrap();
    let full = bounded.into_full().unwrap().session;
    assert_eq!(full.source_text().unwrap(), "```\naxb\n```\n");
    full.undo(1).unwrap().unwrap();
    assert_eq!(full.source_text().unwrap(), "```\nab\n```\n");
}

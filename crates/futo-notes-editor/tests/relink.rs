mod common;
use futo_notes_editor::*;
fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}
#[test]
fn own_relink_adoption_is_revision_bound_and_failed_acceptance_keeps_exact_history() {
    let mut editor = EditorSession::open("[[else]]");
    let mut view = common::ReferenceView::new("[[else]]");
    editor
        .select_with_affinity(Revision(0), range(2, 6), Affinity::Forward)
        .unwrap();
    view.apply(
        editor
            .replace_action(
                Revision(0),
                range(2, 6),
                "old",
                InputAction::Isolated,
                &mut |_| Ok(()),
            )
            .unwrap(),
    );
    assert_eq!(view.text, "[[old]]");
    let action = OwnActionRelink {
        mappings: vec![("old".into(), "long name".into())],
        note_ids: vec!["old".into()],
    };
    assert!(matches!(
        editor.apply_own_relink(Revision(0), &action, &mut |_| Ok(())),
        Err(EditorError::StaleRevision { .. })
    ));
    assert!(matches!(
        editor.apply_own_relink(Revision(1), &action, &mut |_| Err("full disk".into())),
        Err(EditorError::Persistence(_))
    ));
    assert_eq!(editor.source_text(), "[[old]]");
    assert_eq!(editor.selection(), range(5, 5));
    view.apply(
        editor
            .apply_own_relink(Revision(1), &action, &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(editor.source_text(), "[[long name]]");
    assert_eq!(view.text, "[[long name]]");
    view.apply(editor.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), "[[else]]");
    assert_eq!(editor.selection(), range(2, 6));
    assert_eq!(view.text, "[[else]]");
    view.apply(editor.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), "[[long name]]");
    assert_eq!(editor.selection(), range(11, 11));
    assert_eq!(view.text, "[[long name]]");
}

#[test]
fn own_relink_keeps_preexisting_redo_and_partial_historical_links() {
    for (opening, insertion, before, after) in [
        ("[[old]]", "!", "[[long name]]", "[[long name]]!"),
        ("[[ol", "d]]", "[[ol", "[[long name]]"),
    ] {
        let mut editor = EditorSession::open(opening);
        let mut view = common::ReferenceView::new(opening);
        view.apply(
            editor
                .replace_action(
                    Revision(0),
                    range(opening.len(), opening.len()),
                    insertion,
                    InputAction::Isolated,
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        let action = OwnActionRelink {
            mappings: vec![("old".into(), "long name".into())],
            note_ids: vec!["old".into()],
        };
        if opening == "[[old]]" {
            view.apply(editor.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
            view.apply(
                editor
                    .apply_own_relink(Revision(2), &action, &mut |_| Ok(()))
                    .unwrap()
                    .unwrap(),
            );
            assert_eq!(view.text, before);
            view.apply(editor.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(editor.source_text(), after);
        } else {
            view.apply(
                editor
                    .apply_own_relink(Revision(1), &action, &mut |_| Ok(()))
                    .unwrap()
                    .unwrap(),
            );
        }
        assert_eq!(view.text, after);
        view.apply(
            editor
                .undo(editor.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(editor.source_text(), before);
        assert_eq!(view.text, before);
        assert!(editor
            .undo(editor.revision(), &mut |_| Ok(()))
            .unwrap()
            .is_none());
        view.apply(
            editor
                .redo(editor.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(editor.source_text(), after);
        assert_eq!(view.text, after);
    }
}

#[test]
fn own_relink_maps_hidden_unicode_boundaries_by_affinity_without_changing_other_bytes() {
    for (affinity, edge) in [(Affinity::Backward, 6), (Affinity::Forward, 14)] {
        let mut editor = EditorSession::open("__日__ [[old]]");
        let mut view = common::ReferenceView::new("日 [[old]]");
        view.apply(
            editor
                .replace_action(
                    Revision(0),
                    range(11, 11),
                    "!",
                    InputAction::Isolated,
                    &mut |_| Ok(()),
                )
                .unwrap(),
        );
        editor
            .select_with_affinity(Revision(1), range(7, 7), affinity)
            .unwrap();
        let action = OwnActionRelink {
            mappings: vec![("old".into(), "new name".into())],
            note_ids: vec!["old".into()],
        };
        let change = editor
            .apply_own_relink(Revision(1), &action, &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(change.selection, range(edge, edge));
        assert_eq!(change.affinity, affinity);
        view.apply(change);
        assert_eq!(view.text, "日 [[new name]]!");
        assert_eq!(editor.source_text(), "__日__ [[new name]]!");
        view.apply(editor.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(view.text, "日 [[new name]]");
        assert_eq!(editor.source_text(), "__日__ [[new name]]");
    }
}

#[path = "relink/guarded.rs"]
mod guarded;

#[path = "relink/canonical_emitter.rs"]
mod canonical_emitter;

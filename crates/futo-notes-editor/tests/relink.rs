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
    editor
        .select_with_affinity(Revision(0), range(2, 6), Affinity::Forward)
        .unwrap();
    editor
        .replace_action(
            Revision(0),
            range(2, 6),
            "old",
            InputAction::Isolated,
            &mut |_| Ok(()),
        )
        .unwrap();
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
    editor
        .apply_own_relink(Revision(1), &action, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), "[[long name]]");
    editor.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[else]]");
    assert_eq!(editor.selection(), range(2, 6));
    editor.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[long name]]");
    assert_eq!(editor.selection(), range(11, 11));
}

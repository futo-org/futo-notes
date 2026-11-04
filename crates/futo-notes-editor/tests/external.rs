use futo_notes_editor::{DisplayOffset, DisplayRange, EditorError, EditorSession, Revision};

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[test]
fn a_prepared_adoption_cannot_replace_another_sessions_source_or_history() {
    let mut first = EditorSession::open("first\n\nsecond\n");
    let mut other = EditorSession::open("first\n\nsecond\n");
    for session in [&mut first, &mut other] {
        session
            .replace(Revision(0), range(7, 13), "LOCAL", &mut |_| Ok(()))
            .unwrap();
    }
    let adoption = first
        .prepare_external_source(Revision(1), "REMOTE\n\nLOCAL\n")
        .unwrap();
    assert_eq!(
        other.apply_external_source(adoption).unwrap_err(),
        EditorError::StaleClaim
    );
    assert_eq!(other.source_text(), "first\n\nLOCAL\n");
    other.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(other.source_text(), "first\n\nsecond\n");
}

#[test]
fn prepared_adoption_refuses_intervening_selection_or_source_changes() {
    let mut editor = EditorSession::open("first\n\nsecond\n");
    editor
        .replace(Revision(0), range(7, 13), "LOCAL", &mut |_| Ok(()))
        .unwrap();
    let adoption = editor
        .prepare_external_source(Revision(1), "REMOTE\n\nLOCAL\n")
        .unwrap();
    editor.select(Revision(1), range(0, 0)).unwrap();
    assert_eq!(
        editor.apply_external_source(adoption).unwrap_err(),
        EditorError::StaleClaim
    );
    assert_eq!(editor.selection(), range(0, 0));
    let adoption = editor
        .prepare_external_source(Revision(1), "REMOTE\n\nLOCAL\n")
        .unwrap();
    editor
        .replace(Revision(1), range(0, 0), "!", &mut |_| Ok(()))
        .unwrap();
    assert!(matches!(
        editor.apply_external_source(adoption),
        Err(EditorError::StaleRevision { .. })
    ));
    assert_eq!(editor.source_text(), "!first\n\nLOCAL\n");
}

#[test]
fn adoption_delta_preserves_an_unfinished_local_url_and_its_history() {
    let mut editor = EditorSession::open("first\n\n");
    editor
        .replace(Revision(0), range(7, 7), "https://x.test", &mut |_| Ok(()))
        .unwrap();
    assert!(editor
        .project(Revision(1), range(0, 21))
        .unwrap()
        .links
        .is_empty());
    let adoption = editor
        .prepare_external_source(Revision(1), "REMOTE\n\nhttps://x.test")
        .unwrap();
    let change = editor.apply_external_source(adoption).unwrap();
    assert!(
        change.projection.links.is_empty(),
        "the authoritative view delta must retain unfinished URL semantics"
    );
    assert!(editor
        .project(Revision(2), range(0, 22))
        .unwrap()
        .links
        .is_empty());
    editor.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), "REMOTE\n\n");
}

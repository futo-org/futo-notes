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

/// A typed bare URL links at once (GFM's extent); an outside change elsewhere keeps it
/// linked, the change's projection agrees with a fresh open, and undo restores exact bytes.
#[test]
fn adoption_delta_keeps_a_typed_local_url_and_its_history() {
    let mut editor = EditorSession::open("first\n\n");
    editor
        .replace(Revision(0), range(7, 7), "https://x.test", &mut |_| Ok(()))
        .unwrap();
    let links = |editor: &EditorSession, all: DisplayRange| -> Vec<(DisplayRange, String)> {
        editor
            .project(editor.revision(), all)
            .unwrap()
            .links
            .into_iter()
            .map(|link| (link.range, link.destination))
            .collect()
    };
    assert_eq!(
        links(&editor, range(0, 21)),
        [(range(7, 21), "https://x.test".to_owned())]
    );
    let adoption = editor
        .prepare_external_source(Revision(1), "REMOTE\n\nhttps://x.test")
        .unwrap();
    let change = editor.apply_external_source(adoption).unwrap();
    let fresh = EditorSession::open("REMOTE\n\nhttps://x.test");
    assert_eq!(
        change.projection.links,
        fresh
            .project(Revision(0), change.projection.range)
            .unwrap()
            .links,
        "the view delta agrees with a fresh reading"
    );
    assert_eq!(
        links(&editor, range(0, 22)),
        [(range(8, 22), "https://x.test".to_owned())]
    );
    editor.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(editor.source_text(), "REMOTE\n\n");
}

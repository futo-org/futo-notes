//! Ordinary user edits of a supplied typed origin are distinct from new typing seeds.
use super::*;
use futo_notes_editor::InputAction;

#[test]
fn isolated_path_correction_accepts_literal_source_and_undo_restores_typed_lifetime() {
    let original = "<www.x.test/path";
    let corrected = "<www.x.test/math";
    for source in [original, corrected] {
        let fresh = EditorSession::open(source);
        assert_eq!(fresh.display_text(), source);
        assert!(fresh
            .project(Revision(0), range(0, 16))
            .unwrap()
            .links
            .is_empty());
    }
    let mut editor = EditorSession::open("");
    let mut view = ReferenceView::new("");
    view.apply(
        editor
            .replace(Revision(0), range(0, 0), original, &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(editor.source_text(), original);
    assert!(editor
        .project(Revision(1), range(0, 16))
        .unwrap()
        .links
        .is_empty());
    editor.select(Revision(1), range(12, 13)).unwrap();
    let before = editor.source_text();
    let mut accepted = 0;
    let change = editor
        .replace_action(
            Revision(1),
            range(12, 13),
            "m",
            InputAction::Isolated,
            &mut |_| {
                accepted += 1;
                Ok(())
            },
        )
        .expect(
            "a canonical literal ASCII correction inside a live typed word is a valid user edit",
        );
    assert_eq!(accepted, 1);
    view.apply(change);
    assert_eq!(editor.source_text(), corrected);
    assert_eq!(view.text, corrected);
    assert_eq!(editor.selection(), range(13, 13));
    let fresh = EditorSession::open(&editor.source_text());
    assert_eq!(fresh.display_text(), view.text);
    assert!(fresh
        .project(Revision(0), range(0, 16))
        .unwrap()
        .links
        .is_empty());
    view.apply(editor.undo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), before);
    assert_eq!(view.text, original);
    assert!(editor
        .project(Revision(3), range(0, 16))
        .unwrap()
        .links
        .is_empty());
    view.apply(editor.redo(Revision(3), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), corrected);
    assert_eq!(view.text, corrected);
    view.apply(editor.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    editor.select(Revision(5), range(16, 16)).unwrap();
    view.apply(
        editor
            .replace(Revision(5), range(16, 16), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "<www.x.test/path>");
    assert!(editor
        .project(Revision(6), range(0, 17))
        .unwrap()
        .links
        .is_empty());
    editor.select(Revision(6), range(0, 0)).unwrap();
    editor.select(Revision(6), range(17, 17)).unwrap();
    view.apply(
        editor
            .replace(Revision(6), range(17, 17), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    let link = editor
        .inspect_link(Revision(7), range(1, 2))
        .unwrap()
        .unwrap();
    assert_eq!(link.range, range(1, 16));
    assert_eq!(link.destination, "http://www.x.test/path");
    assert_eq!(view.text, "<www.x.test/path> ");
}

//! Current foreign fields before an actual reference repair retain their identity.
use super::*;
use futo_notes_editor::BlockCommand;

#[test]
fn a_live_typed_word_before_the_repair_keeps_its_original_word_end_authority() {
    let original = "lead \n\n[id]: /target extra\n\n[one][id]";
    let word = "<www.x.test/path";
    let prefix = format!("lead {word}\n\n");
    let expected = format!("{prefix}\\[id]: /target\n***\n\n extra\n\n[one][id]");
    let shown = format!("{prefix}[id]: /target\n\u{fffc}\n\n extra\n\n[one][id]");
    let canonical = EditorSession::open(&expected);
    assert_eq!(canonical.display_text(), shown);
    assert!(canonical
        .project(Revision(0), range(0, shown.len()))
        .unwrap()
        .links
        .is_empty());
    let mut editor = EditorSession::open(original);
    let mut view = ReferenceView::new(original);
    view.apply(
        editor
            .replace(Revision(0), range(5, 5), word, &mut |_| Ok(()))
            .unwrap(),
    );
    let before = editor.source_text();
    let at = prefix.len() + 13;
    view.apply(
        editor
            .block_command(
                Revision(1),
                range(at, at),
                BlockCommand::Divider,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(editor.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(
        editor.selection(),
        range(prefix.len() + 18, prefix.len() + 18)
    );
    let end = 5 + word.len();
    editor.select(Revision(2), range(end, end)).unwrap();
    view.apply(
        editor
            .replace(Revision(2), range(end, end), ">", &mut |_| Ok(()))
            .unwrap(),
    );
    assert!(editor
        .inspect_link(Revision(3), range(6, 7))
        .unwrap()
        .is_none());
    view.apply(
        editor
            .replace(Revision(3), range(end + 1, end + 1), " ", &mut |_| Ok(()))
            .unwrap(),
    );
    let link = editor
        .inspect_link(Revision(4), range(6, 7))
        .unwrap()
        .unwrap();
    assert_eq!(link.range, range(6, end));
    assert_eq!(link.destination, "http://www.x.test/path");
    assert!(editor
        .source_text()
        .ends_with("\\[id]: /target\n***\n\n extra\n\n[one][id]"));
    view.apply(editor.undo(Revision(4), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(editor.undo(Revision(5), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), before);
    view.apply(editor.redo(Revision(6), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(editor.source_text(), expected);
}

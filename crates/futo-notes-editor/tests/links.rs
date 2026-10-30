use futo_notes_editor::{DisplayOffset, DisplayRange, EditorSession, Revision};
mod common;
use common::ReferenceView;

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[test]
fn correcting_nested_link_label_preserves_destination_spelling_and_exact_history() {
    let original = "see [teh __docs__](<https://x.test/a> \"Title\")\t\r\n";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new("see teh docs\t\r\n");
    assert_eq!(session.display_text(), view.text);
    view.apply(
        session
            .replace(Revision(0), range(4, 7), "the", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(view.text, "see the docs\t\r\n");
    assert_eq!(
        session.source_text(),
        "see [the __docs__](<https://x.test/a> \"Title\")\t\r\n"
    );
    view.apply(session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(session.source_text(), original);
    assert_eq!(view.text, "see teh docs\t\r\n");
    view.apply(session.redo(Revision(2), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(
        session.source_text(),
        "see [the __docs__](<https://x.test/a> \"Title\")\t\r\n"
    );
}

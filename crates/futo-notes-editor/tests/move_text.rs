//! Drag-to-move: a cut and a paste at the drop, one Undo step.
mod common;

use common::ReferenceView;
use futo_notes_editor::{DisplayOffset, DisplayRange, EditorSession};

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

/// Move `start..end` to `to`; the selected text after it.
fn moved(
    session: &mut EditorSession,
    view: &mut ReferenceView,
    start: usize,
    end: usize,
    to: usize,
) -> String {
    let mut edits = 0;
    let changes = session
        .move_markdown(
            session.revision(),
            range(start, end),
            DisplayOffset(to),
            &mut |_| {
                edits += 1;
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(edits, changes.len(), "each change is one edit for the host");
    for change in changes {
        view.apply(change);
    }
    assert_eq!(view.text, session.display_text());
    let selection = session.selection();
    view.text[selection.start.0..selection.end.0].to_owned()
}

#[test]
fn a_moved_word_keeps_its_formatting_lands_selected_and_undoes_in_one_step() {
    let mut session = EditorSession::open("a **bold** word here");
    let mut view = ReferenceView::new(&session.display_text());
    session.select(session.revision(), range(2, 6)).unwrap();
    // "bold" after "word".
    assert_eq!(moved(&mut session, &mut view, 2, 6, 11), "bold");
    assert_eq!(session.source_text(), "a  word**bold** here");
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "a **bold** word here");
    assert_eq!(view.text, session.display_text());
    assert_eq!(session.selection(), range(2, 6));
    view.apply(
        session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), "a  word**bold** here");
    assert_eq!(view.text, session.display_text());
    assert_eq!(session.selection(), range(7, 11));
}

#[test]
fn a_move_backward_lands_where_dropped() {
    let mut session = EditorSession::open("one two three");
    let mut view = ReferenceView::new(&session.display_text());
    assert_eq!(moved(&mut session, &mut view, 8, 13, 0), "three");
    assert_eq!(session.source_text(), "threeone two ");
}

#[test]
fn a_drop_inside_the_selection_moves_nothing() {
    let mut session = EditorSession::open("one two three");
    let changes = session
        .move_markdown(
            session.revision(),
            range(4, 7),
            DisplayOffset(5),
            &mut |_| Ok(()),
        )
        .unwrap();
    assert!(changes.is_empty());
    assert_eq!(session.source_text(), "one two three");
}

#[test]
fn a_paste_that_cannot_land_takes_the_cut_back() {
    let source = "---\na: b\n---\none two";
    let mut session = EditorSession::open(source);
    let mut view = ReferenceView::new(&session.display_text());
    // `two` dropped into the front matter (`a: b`), which input never changes.
    let changes = session
        .move_markdown(
            session.revision(),
            range(9, 12),
            DisplayOffset(1),
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(changes.len(), 2, "the cut, then taking it back");
    for change in changes {
        view.apply(change);
    }
    assert_eq!(session.source_text(), source);
    assert_eq!(view.text, session.display_text());
    assert!(session
        .redo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .is_none());
}

#[test]
fn a_drop_beside_repeated_text_lands_where_dropped() {
    let mut session = EditorSession::open("a a b");
    let mut view = ReferenceView::new(&session.display_text());
    assert_eq!(moved(&mut session, &mut view, 0, 2, 3), "a ");
    assert_eq!(session.source_text(), "aa  b");
    let mut session = EditorSession::open("b a a");
    let mut view = ReferenceView::new(&session.display_text());
    assert_eq!(moved(&mut session, &mut view, 3, 5, 2), " a");
    assert_eq!(session.source_text(), "b  aa");
}

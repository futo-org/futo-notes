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
fn replacing_plain_text_preserves_untouched_source_and_updates_the_reference_view() {
    // A line's leading whitespace is its indent, which renderers draw; it is not shown
    // as text, and it is kept byte for byte.
    let mut session = EditorSession::open("  first\r\nsecond\t \r\nlast");
    let mut view = ReferenceView::new("first\r\nsecond\t \r\nlast");
    assert_eq!(session.display_text(), view.text);
    let mut accepted = Vec::new();
    let change = session
        .replace(
            Revision(0),
            DisplayRange {
                start: DisplayOffset(7),
                end: DisplayOffset(13),
            },
            "new",
            &mut |edit| {
                accepted.push(edit.clone());
                Ok(())
            },
        )
        .unwrap();
    view.apply(change.clone());
    assert_eq!(view.text, "first\r\nnew\t \r\nlast");
    assert_eq!(session.source_text(), "  first\r\nnew\t \r\nlast");
    assert_eq!(change.revision, Revision(1));
    assert_eq!(
        change.selection,
        DisplayRange {
            start: DisplayOffset(10),
            end: DisplayOffset(10)
        }
    );
    assert_eq!(accepted.len(), 1);
}

#[test]
fn insertion_deletion_and_replacement_undo_and_redo_exact_bytes() {
    let mut session = EditorSession::open("a\r\nb  ");
    let mut view = ReferenceView::new("a\r\nb  ");
    let mut apply = |change: futo_notes_editor::ViewChange| {
        view.apply(change);
    };
    let mut accept = |_: &futo_notes_editor::SourceEdit| Ok(());
    apply(
        session
            .replace(Revision(0), range(1, 1), "!", &mut accept)
            .unwrap(),
    );
    apply(
        session
            .replace(Revision(1), range(4, 5), "", &mut accept)
            .unwrap(),
    );
    apply(
        session
            .replace(Revision(2), range(0, 1), "A", &mut accept)
            .unwrap(),
    );
    assert_eq!(session.source_text(), "A!\r\n  ");
    apply(session.undo(Revision(3), &mut accept).unwrap().unwrap());
    apply(session.undo(Revision(4), &mut accept).unwrap().unwrap());
    apply(session.undo(Revision(5), &mut accept).unwrap().unwrap());
    assert_eq!(session.source_text(), "a\r\nb  ");
    apply(session.redo(Revision(6), &mut accept).unwrap().unwrap());
    apply(session.redo(Revision(7), &mut accept).unwrap().unwrap());
    apply(session.redo(Revision(8), &mut accept).unwrap().unwrap());
    assert_eq!(session.source_text(), "A!\r\n  ");
    assert_eq!(view.text, "A!\r\n  ");
}

#[test]
fn invalid_or_unprotected_input_leaves_the_session_and_history_unchanged() {
    use futo_notes_editor::{EditorError, SourceEdit};
    let mut session = EditorSession::open("a😀z");
    let mut refuse = |_: &SourceEdit| Err("disk full".to_owned());
    assert_eq!(
        session.replace(Revision(0), range(1, 1), "!", &mut refuse),
        Err(EditorError::Persistence("disk full".to_owned()))
    );
    let mut unexpected = |_: &SourceEdit| panic!("invalid input reached persistence");
    assert_eq!(
        session.replace(Revision(0), range(2, 2), "!", &mut unexpected),
        Err(EditorError::InvalidRange)
    );
    assert_eq!(
        session.replace(Revision(1), range(0, 0), "!", &mut unexpected),
        Err(EditorError::StaleRevision {
            expected: Revision(1),
            actual: Revision(0)
        })
    );
    assert_eq!(session.source_text(), "a😀z");
    assert_eq!(session.revision(), Revision(0));
    assert!(session
        .undo(Revision(0), &mut unexpected)
        .unwrap()
        .is_none());
}

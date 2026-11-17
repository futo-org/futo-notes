//! Transpose (Ctrl+T on Apple): one swap, one Undo step that puts the caret back.
mod common;

use common::ReferenceView;
use futo_notes_editor::ParagraphKey::Transpose;
use futo_notes_editor::{DisplayOffset, DisplayRange, EditorSession};

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[test]
fn transpose_swaps_the_graphemes_at_the_caret_and_undo_puts_the_caret_back() {
    for (opening, display, at, expected, shown, after) in [
        ("abcd", "abcd", 2, "acbd", "acbd", 3),
        // At a line's end the two before the caret swap, as AppKit's transpose does.
        ("ab\ncd", "ab\ncd", 2, "ba\ncd", "ba\ncd", 2),
        ("a😀b", "a😀b", 1, "😀ab", "😀ab", 5),
        ("# ab", "ab", 1, "# ba", "ba", 2),
    ] {
        let mut s = EditorSession::open(opening);
        let mut v = ReferenceView::new(display);
        s.select(s.revision(), range(at, at)).unwrap();
        let mut edits = 0;
        v.apply(
            s.paragraph_key(s.revision(), range(at, at), Transpose, &mut |_| {
                edits += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(edits, 1, "{opening:?}");
        assert_eq!(s.source_text(), expected, "{opening:?}");
        assert_eq!(v.text, shown);
        assert_eq!(s.selection(), range(after, after), "{opening:?}");
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), opening);
        assert_eq!(v.text, s.display_text());
        assert_eq!(s.selection(), range(at, at), "{opening:?}");
    }
    // A selection, the note's start, a line's start and a lone character are no edit.
    for (opening, selected) in [
        ("abcd", range(1, 3)),
        ("ab", range(0, 0)),
        ("ab\ncd", range(3, 3)),
        ("ab\nc", range(4, 4)),
    ] {
        let mut s = EditorSession::open(opening);
        let result = s
            .paragraph_key(s.revision(), selected, Transpose, &mut |_| Ok(()))
            .unwrap();
        assert!(result.is_none(), "{opening:?} {selected:?}");
        assert_eq!(s.source_text(), opening);
    }
}

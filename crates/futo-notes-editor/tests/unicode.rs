use futo_notes_editor::{
    DisplayOffset, DisplayRange, DisplayUtf16Offset, DisplayUtf16Range, EditorError, EditorSession,
    Revision, SourceOffset, SourceRange, SourceUtf16Offset, SourceUtf16Range,
};
mod common;
use common::ReferenceView;

fn bytes(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}
fn utf16(start: usize, end: usize) -> DisplayUtf16Range {
    DisplayUtf16Range {
        start: DisplayUtf16Offset(start),
        end: DisplayUtf16Offset(end),
    }
}

#[test]
fn native_unicode_replacement_uses_checked_source_and_display_coordinates() {
    let original = "A😀e\u{301}日\r\n한\rن\n";
    let mut session = EditorSession::open(original);
    let mut view = ReferenceView::new(original);
    assert_eq!(
        session
            .display_from_utf16(Revision(0), utf16(1, 6))
            .unwrap(),
        bytes(1, 11)
    );
    assert_eq!(
        session.display_to_utf16(Revision(0), bytes(1, 11)).unwrap(),
        utf16(1, 6)
    );
    assert_eq!(
        session
            .source_from_utf16(
                Revision(0),
                SourceUtf16Range {
                    start: SourceUtf16Offset(1),
                    end: SourceUtf16Offset(6),
                }
            )
            .unwrap(),
        SourceRange {
            start: SourceOffset(1),
            end: SourceOffset(11)
        }
    );
    assert_eq!(
        session
            .source_to_utf16(
                Revision(0),
                SourceRange {
                    start: SourceOffset(1),
                    end: SourceOffset(11),
                }
            )
            .unwrap(),
        SourceUtf16Range {
            start: SourceUtf16Offset(1),
            end: SourceUtf16Offset(6)
        }
    );
    // Worked UTF-8 byte/UTF-16 unit boundaries include both sides of every
    // mixed-script scalar and each source line-ending code point.
    for (byte, unit) in [
        (0, 0),
        (1, 1),
        (5, 3),
        (6, 4),
        (8, 5),
        (11, 6),
        (12, 7),
        (13, 8),
        (16, 9),
        (17, 10),
        (19, 11),
        (20, 12),
    ] {
        assert_eq!(
            session
                .display_from_utf16(Revision(0), utf16(unit, unit))
                .unwrap(),
            bytes(byte, byte)
        );
        assert_eq!(
            session
                .display_to_utf16(Revision(0), bytes(byte, byte))
                .unwrap(),
            utf16(unit, unit)
        );
    }
    let mut records = Vec::new();
    let change = session
        .replace_utf16(
            Revision(0),
            utf16(1, 6),
            &"👩🏽\u{200d}💻中文".encode_utf16().collect::<Vec<_>>(),
            &mut |edit| {
                records.push(edit.clone());
                Ok(())
            },
        )
        .unwrap();
    view.apply(change.clone());
    assert_eq!(view.text, "A👩🏽\u{200d}💻中文\r\n한\rن\n");
    assert_eq!(session.source_text(), view.text);
    assert_eq!(change.selection, bytes(22, 22));
    assert_eq!(records[0].removed, "😀e\u{301}日");
    assert_eq!(
        session.display_from_utf16(Revision(0), utf16(0, 0)),
        Err(EditorError::StaleRevision {
            expected: Revision(0),
            actual: Revision(1)
        })
    );
}

#[test]
fn selection_updates_are_separate_from_source_changes_and_history_restores_them() {
    let mut session = EditorSession::open("a😀日");
    let mut view = ReferenceView::new("a😀日");
    let selection = session.select(Revision(0), bytes(1, 5)).unwrap();
    assert_eq!(selection.revision, Revision(0));
    assert_eq!(selection.selection, bytes(1, 5));
    let mut accept = |_: &futo_notes_editor::SourceEdit| Ok(());
    assert!(session.undo(Revision(0), &mut accept).unwrap().is_none());
    let change = session
        .replace_utf16(Revision(0), utf16(1, 3), &[0x4E2D], &mut accept)
        .unwrap();
    assert_eq!(change.selection, bytes(4, 4));
    view.apply(change);
    assert_eq!(view.text, "a中日");
    session.select(Revision(1), bytes(0, 0)).unwrap();
    let undo = session.undo(Revision(1), &mut accept).unwrap().unwrap();
    assert_eq!(undo.selection, bytes(1, 5));
    view.apply(undo);
    assert_eq!(view.text, "a😀日");
    assert_eq!(session.selection(), bytes(1, 5));
    assert_eq!(session.source_text(), "a😀日");
    let redo = session.redo(Revision(2), &mut accept).unwrap().unwrap();
    assert_eq!(redo.selection, bytes(4, 4));
    view.apply(redo);
    assert_eq!(view.text, "a中日");
    assert_eq!(session.selection(), bytes(4, 4));
    assert_eq!(session.source_text(), "a中日");
}

#[test]
fn caret_movement_steps_over_extended_graphemes_and_line_endings() {
    use futo_notes_editor::CaretDirection::{Backward, Forward};
    let mut session = EditorSession::open("ae\u{301}👩🏽\u{200d}💻🇺🇸日\r\n한\rن\n");
    for offset in [1, 4, 19, 27, 30, 32, 35, 36, 38, 39, 39] {
        let change = session.move_caret(Revision(0), Forward).unwrap();
        assert_eq!(change.selection, bytes(offset, offset));
        assert_eq!(change.revision, Revision(0));
    }
    for offset in [38, 36, 35, 32, 30, 27, 19, 4, 1, 0, 0] {
        assert_eq!(
            session.move_caret(Revision(0), Backward).unwrap().selection,
            bytes(offset, offset)
        );
    }
    // Foreign code-point replacements may target part of a grapheme. Caret
    // navigation still moves to a visible-character stop from such a position.
    session.select(Revision(0), bytes(2, 2)).unwrap();
    assert_eq!(
        session.move_caret(Revision(0), Forward).unwrap().selection,
        bytes(4, 4)
    );
    session.select(Revision(0), bytes(2, 2)).unwrap();
    assert_eq!(
        session.move_caret(Revision(0), Backward).unwrap().selection,
        bytes(1, 1)
    );
    session.select(Revision(0), bytes(1, 27)).unwrap();
    assert_eq!(
        session.move_caret(Revision(0), Backward).unwrap().selection,
        bytes(1, 1)
    );
}

#[test]
fn invalid_native_input_and_duplicate_callbacks_preserve_text_selection_and_history() {
    let mut session = EditorSession::open("a😀e\u{301}日");
    session.select_utf16(Revision(0), utf16(1, 3)).unwrap();
    let mut unexpected =
        |_: &futo_notes_editor::SourceEdit| panic!("invalid input reached acceptance");
    for range in [
        utf16(2, 2),
        utf16(1, 2),
        utf16(3, 1),
        utf16(0, 8),
        utf16(usize::MAX, usize::MAX),
    ] {
        assert_eq!(
            session.replace_utf16(Revision(0), range, &[0x21], &mut unexpected),
            Err(EditorError::InvalidRange)
        );
        assert_eq!(
            session.select_utf16(Revision(0), range),
            Err(EditorError::InvalidRange)
        );
    }
    for text in [&[0xD800][..], &[0xDC00][..], &[0xD800, 0x61][..]] {
        assert_eq!(
            session.replace_utf16(Revision(0), utf16(1, 3), text, &mut unexpected),
            Err(EditorError::InvalidText)
        );
    }
    for range in [bytes(2, 2), bytes(1, 4), bytes(5, 1), bytes(0, usize::MAX)] {
        assert_eq!(
            session.replace(Revision(0), range, "!", &mut unexpected),
            Err(EditorError::InvalidRange)
        );
        assert_eq!(
            session.select(Revision(0), range),
            Err(EditorError::InvalidRange)
        );
    }
    assert_eq!(session.source_text(), "a😀e\u{301}日");
    assert_eq!(session.selection(), bytes(1, 5));
    assert_eq!(session.revision(), Revision(0));
    assert!(session
        .undo(Revision(0), &mut unexpected)
        .unwrap()
        .is_none());
    let mut accepted = Vec::new();
    let event = [0xD83D, 0xDE80];
    session
        .replace_utf16(Revision(0), utf16(1, 3), &event, &mut |edit| {
            accepted.push(edit.clone());
            Ok(())
        })
        .unwrap();
    // A native notification generated by applying the result carries the old
    // revision. Reject it before invoking the host or changing selection/history.
    assert_eq!(
        session.replace_utf16(Revision(0), utf16(1, 3), &event, &mut unexpected),
        Err(EditorError::StaleRevision {
            expected: Revision(0),
            actual: Revision(1)
        })
    );
    assert_eq!(
        session.select_utf16(Revision(0), utf16(0, 0)),
        Err(EditorError::StaleRevision {
            expected: Revision(0),
            actual: Revision(1)
        })
    );
    assert_eq!(session.source_text(), "a🚀e\u{301}日");
    assert_eq!(session.selection(), bytes(5, 5));
    let mut accept = |_: &futo_notes_editor::SourceEdit| Ok(());
    session.undo(Revision(1), &mut accept).unwrap().unwrap();
    assert!(session
        .undo(Revision(2), &mut unexpected)
        .unwrap()
        .is_none());
    assert_eq!(session.source_text(), "a😀e\u{301}日");
    assert_eq!(session.selection(), bytes(1, 5));
    assert_eq!(accepted.len(), 1);
}

#[test]
fn collapsing_a_native_selection_never_leaves_the_caret_inside_a_grapheme() {
    use futo_notes_editor::CaretDirection::{Backward, Forward};
    let mut session = EditorSession::open("ae\u{301}👩🏽\u{200d}💻z");
    session.select(Revision(0), bytes(2, 8)).unwrap();
    assert_eq!(
        session.move_caret(Revision(0), Backward).unwrap().selection,
        bytes(1, 1)
    );
    session.select(Revision(0), bytes(2, 8)).unwrap();
    assert_eq!(
        session.move_caret(Revision(0), Forward).unwrap().selection,
        bytes(19, 19)
    );
}

#[test]
fn grapheme_movement_crosses_rope_chunks_without_splitting_long_clusters() {
    use futo_notes_editor::CaretDirection::{Backward, Forward};
    let text = format!("ae{}z", "\u{301}".repeat(3000));
    let mut session = EditorSession::open(&text);
    session.select(Revision(0), bytes(1, 1)).unwrap();
    assert_eq!(
        session.move_caret(Revision(0), Forward).unwrap().selection,
        bytes(6002, 6002)
    );
    assert_eq!(
        session.move_caret(Revision(0), Backward).unwrap().selection,
        bytes(1, 1)
    );
    session.select(Revision(0), bytes(3002, 4002)).unwrap();
    assert_eq!(
        session.move_caret(Revision(0), Forward).unwrap().selection,
        bytes(6002, 6002)
    );
    session.select(Revision(0), bytes(3002, 4002)).unwrap();
    assert_eq!(
        session.move_caret(Revision(0), Backward).unwrap().selection,
        bytes(1, 1)
    );

    let mut flags = EditorSession::open(&"🇺🇸".repeat(400));
    flags.select(Revision(0), bytes(3192, 3192)).unwrap();
    assert_eq!(
        flags.move_caret(Revision(0), Backward).unwrap().selection,
        bytes(3184, 3184)
    );
    assert_eq!(
        flags.move_caret(Revision(0), Forward).unwrap().selection,
        bytes(3192, 3192)
    );
}

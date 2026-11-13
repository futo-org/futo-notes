//! The session's table surface on the core.
use super::super::ok;
use super::caret;
use crate::{
    DisplayOffset, DisplayRange, EditorError, ParagraphKey, TableCommand, TableKey, TableOutcome,
};

/// The session's table methods run on the core under the switch, the
/// UTF-16 entry points included.
#[test]
fn the_session_surface_runs_tables_on_the_core() {
    use crate::{DisplayUtf16Offset, DisplayUtf16Range, EditorSession};
    let mut session = EditorSession::open("| \u{1F600}a | b |\n| - | - |\n| c | d |\n");
    let revision = session.revision();
    let table = session
        .inspect_table(revision, caret(0))
        .unwrap()
        .expect("a table");
    assert_eq!((table.columns, table.rows.len()), (2, 2));
    let whole = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(session.display_text().len()),
    };
    assert_eq!(
        session.inspect_tables(revision, whole).unwrap(),
        vec![table.clone()]
    );
    let first = table.rows[0][0].content;
    let native = session.display_to_utf16(revision, first).unwrap();
    assert_eq!(native.end.0 - native.start.0, 3);
    let found = session
        .inspect_table_utf16(revision, native)
        .unwrap()
        .unwrap();
    assert_eq!(
        found.focus.map(|focus| (focus.row, focus.column)),
        Some((0, 0))
    );
    let split = DisplayUtf16Range {
        start: DisplayUtf16Offset(native.start.0 + 1),
        end: native.end,
    };
    assert_eq!(
        session.inspect_table_utf16(revision, split),
        Err(EditorError::InvalidRange)
    );
    // Tab moves with no edit; Enter on the last row appends one.
    session.select(revision, caret(first.end.0)).unwrap();
    let Some(TableOutcome::Selected(moved)) =
        session.table_key(revision, TableKey::Tab, &mut ok).unwrap()
    else {
        panic!("Tab selects the next cell");
    };
    assert_eq!(moved.selection, table.rows[0][1].content);
    let moved = session
        .paragraph_key(revision, session.selection(), ParagraphKey::Enter, &mut ok)
        .unwrap()
        .expect("a move");
    assert_eq!(moved.revision, revision);
    assert_eq!(moved.selection, table.rows[1][1].content);
    let Some(TableOutcome::Edited(_)) = session
        .table_key(revision, TableKey::Enter, &mut ok)
        .unwrap()
    else {
        panic!("Enter on the last row appends a row");
    };
    assert_eq!(
        session.source_text(),
        "| \u{1F600}a | b |\n| - | - |\n| c | d |\n|  |  |\n"
    );
    let at = session.display_to_utf16(session.revision(), first).unwrap();
    session
        .table_command_utf16(session.revision(), at, TableCommand::DeleteColumn, &mut ok)
        .unwrap()
        .expect("a column deleted");
    assert_eq!(session.source_text(), "| b |\n| - |\n| d |\n|  |\n");
    session.undo(session.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(
        session.source_text(),
        "| \u{1F600}a | b |\n| - | - |\n| c | d |\n|  |  |\n"
    );
}

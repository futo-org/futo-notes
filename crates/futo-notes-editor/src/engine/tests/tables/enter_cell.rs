//! A host entering a cell by its row's position and its column
//! (`enter_table_cell`), as a table key enters one.
use super::super::super::Engine;
use super::super::ok;
use super::{caret, display, marked};
use crate::{DisplayOffset, EditorError, Revision, TableOutcome};

/// Enter cell `column` of the row at source offset `at`.
fn enter(engine: &mut Engine, at: usize, column: usize) -> Option<TableOutcome> {
    let at = DisplayOffset(engine.display_of(at));
    engine
        .enter_table_cell(engine.revision(), at, column, &mut ok)
        .unwrap()
}

/// The edit `before` takes from entering cell `column` of the row at
/// source offset `at`: `after` with its caret, then one Undo back to
/// `before`.
fn check_added(before: &str, at: usize, column: usize, after: &str) {
    let mut engine = Engine::open(before);
    let Some(TableOutcome::Edited(_)) = enter(&mut engine, at, column) else {
        panic!("{before:?}: the row gains cells");
    };
    let (source, selection) = marked(after);
    assert_eq!(engine.source_text(), source);
    assert_eq!(engine.selection(), display(&engine, &selection));
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), before, "one Undo step");
}

#[test]
fn an_existing_cell_is_selected_with_no_edit() {
    let before = "| a | b |\n|---|---|\n| c | d |";
    let mut engine = Engine::open(before);
    let revision = engine.revision();
    let Some(TableOutcome::Selected(moved)) = enter(&mut engine, 20, 1) else {
        panic!("a selection move");
    };
    let (_, content) = marked("| a | b |\n|---|---|\n| c | «d» |");
    assert_eq!(moved.selection, display(&engine, &content));
    assert_eq!(
        (engine.revision(), engine.source_text()),
        (revision, before.into())
    );
}

/// From the row's start, and from past its last pipe: anywhere on the line.
#[test]
fn a_row_lacking_cells_gains_them_in_one_edit() {
    let one_short = "| a | b |\n|---|---|\n| c |";
    check_added(
        one_short,
        one_short.len(),
        1,
        "| a | b |\n|---|---|\n| c | ‸ |",
    );
    let two_short = "| a | b | c |\n|---|---|---|\n| d |";
    check_added(
        two_short,
        28,
        2,
        "| a | b | c |\n|---|---|---|\n| d |  | ‸ |",
    );
}

#[test]
fn a_header_gaining_a_cell_gives_its_delimiter_row_one() {
    check_added(
        "| a |\n|---|\n| b | c |",
        0,
        1,
        "| a | ‸ |\n|---| --- |\n| b | c |",
    );
}

#[test]
fn off_a_header_or_body_row_or_past_the_columns_nothing_is_done() {
    let before = "text\n| a | b |\n|---|---|\n| c |";
    for (at, column) in [(0, 0), (15, 0), (25, 2), (25, 5)] {
        let mut engine = Engine::open(before);
        let revision = engine.revision();
        assert!(enter(&mut engine, at, column).is_none(), "{at}, {column}");
        assert_eq!(
            (engine.revision(), engine.source_text()),
            (revision, before.into())
        );
    }
}

#[test]
fn a_stale_revision_is_refused() {
    let mut engine = Engine::open("| a |\n|---|\n| b |");
    let stale = Revision(engine.revision().0 + 1);
    let refused = engine.enter_table_cell(stale, caret(0).start, 0, &mut ok);
    assert!(matches!(refused, Err(EditorError::StaleRevision { .. })));
}

/// The session's UTF-16 entry point counts native units: the emoji above
/// the row is two.
#[test]
fn the_session_enters_a_cell_at_a_utf16_offset() {
    use crate::{DisplayUtf16Offset, EditorSession};
    let mut session = EditorSession::open("| \u{1F600} | b |\n|---|---|\n| c |");
    let end = session.display_text().encode_utf16().count();
    let Some(TableOutcome::Edited(_)) = session
        .enter_table_cell_utf16(session.revision(), DisplayUtf16Offset(end), 1, &mut ok)
        .unwrap()
    else {
        panic!("the row gains a cell");
    };
    assert_eq!(
        session.source_text(),
        "| \u{1F600} | b |\n|---|---|\n| c |  |"
    );
}

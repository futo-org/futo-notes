//! Counted work of table edits, against the old engine's budgets.
use super::super::super::Engine;
use super::super::ok;
use super::{caret, total};
use crate::{InputAction, ParagraphKey, TableCommand};

/// The budget of `tests/long_regions.rs`
/// `a_long_pipeless_table_tail_still_edits_as_a_cell`. A line without a
/// leading pipe is no table row, so the 400 `bar` lines are plain lines and
/// a `|` typed at the end of the last one lands as typed. The old engine
/// read that tail as table cells and wrote `\|`, for 4,041 units of work.
#[test]
fn a_pipe_typed_after_a_pipeless_tail_is_typing_on_a_plain_line() {
    let rows: String = (0..400).map(|i| format!("bar {i}\n")).collect();
    let source = format!("| a | b |\n|---|---|\n| 1 | 2 |\n{rows}");
    let mut engine = Engine::open(&source);
    let end = engine.display_len() - 1;
    let change = engine
        .input(
            engine.revision(),
            caret(end),
            "|",
            InputAction::Typing,
            &mut ok,
        )
        .unwrap();
    assert!(engine.source_text().ends_with("\nbar 399|\n"));
    assert!(total(&change.work) <= 4_041, "{:?}", change.work);
}

/// A table of URL cells, the shape of the slow corpus note in
/// `tests/table_rows.rs`.
fn url_table(rows: usize) -> String {
    let mut source = String::from("| Name | Site | Twitter |\n| --- | --- | --- |\n");
    for i in 0..rows {
        source += &format!(
            "| duck eggs {i} | https://duck{i}.example.com/notes/{i} | https://twitter.com/duck{i} |\n"
        );
    }
    source
}

/// Work for a key and two commands in the middle row of a table of `rows`
/// rows: typing, Backspace, Enter in a cell, a row inserted, a column
/// inserted.
fn table_work(rows: usize) -> [usize; 5] {
    let source = url_table(rows);
    let needle = format!("duck eggs {}", rows / 2);
    let at = source.find(&format!("{needle} ")).unwrap() + needle.len();
    let mut engine = Engine::open(&source);
    engine.land(at..at, None);
    let typed = engine
        .input(
            engine.revision(),
            caret(at),
            "x",
            InputAction::Typing,
            &mut ok,
        )
        .unwrap()
        .work;
    let deleted = engine
        .key(
            engine.revision(),
            caret(at + 1),
            ParagraphKey::Backspace,
            &mut ok,
        )
        .unwrap()
        .unwrap()
        .work;
    assert_eq!(engine.source_text(), source);
    let entered = engine
        .key(engine.revision(), caret(at), ParagraphKey::Enter, &mut ok)
        .unwrap()
        .unwrap()
        .work;
    engine.land(at..at, None);
    let row = engine
        .run_table_command(
            engine.revision(),
            caret(at),
            TableCommand::InsertRowBelow,
            &mut ok,
        )
        .unwrap()
        .unwrap()
        .work;
    let column = engine
        .run_table_command(
            engine.revision(),
            engine.selection(),
            TableCommand::InsertColumnRight,
            &mut ok,
        )
        .unwrap()
        .unwrap()
        .work;
    assert_eq!(
        engine.display_text(),
        Engine::open(&engine.source_text()).display_text()
    );
    [typed, deleted, entered, row, column].map(|work| total(&work))
}

/// No table staging: typing, Backspace and Enter in a cell cost the same at
/// 20,000 rows as at 100. Row and column commands read the whole table to
/// find its width (a column command also writes every row), so their work
/// grows with the table, linearly. Measured (type, Backspace, Enter, insert
/// row, insert column): 100 rows [270, 269, 0, 8709, 51720]; 20,000 rows
/// [302, 301, 0, 1875945, 11533493], for a 1.9 MB table. The old engine at
/// 20,000 rows: type 3201, Backspace 3114, Enter in a cell 141.
#[test]
fn table_edits_at_20000_rows() {
    let small = table_work(100);
    let large = table_work(20_000);
    let bytes = url_table(20_000).len();
    for (key, (large, small)) in ["type", "backspace", "cell enter"]
        .iter()
        .zip(large.iter().zip(&small))
    {
        assert!(
            *large <= small * 3 / 2 + 1024,
            "{key}: {small} at 100 rows, {large} at 20,000"
        );
    }
    assert!(large[3] <= 2 * bytes, "insert row {}", large[3]);
    // Every row is written: the edit's own bytes, read once and kept once.
    assert!(large[4] <= 8 * bytes, "insert column {}", large[4]);
    eprintln!("table work at 100 rows {small:?}, at 20,000 rows {large:?} (table {bytes} bytes)");
}

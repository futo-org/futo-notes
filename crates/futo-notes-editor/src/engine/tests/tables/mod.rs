//! Tables: the literal cases in `tests/fixtures/engine/tables.json`. Random
//! tables are in `random.rs`, the work at 20,000 rows in `work.rs` and the
//! session surface in `surface.rs`.
//!
//! A case's `before` and `after` are source text with the selection marked:
//! `‸` is a caret, `«` and `»` bound a selection (a table's `|` cannot mark
//! one). `command` is a table key (`Tab`, `ShiftTab`, `Enter`, `ShiftEnter`,
//! `ModEnter`), `key <ParagraphKey>`, a `TableCommand` name, `type <text>`,
//! `service <text>` (a text service's or dictation's insert) or `paste <text>`. `after: null` means nothing changes: no edit, no history,
//! the same selection; `error` names the error instead. Every case that edits
//! is undone (bytes and selection back) and redone. `inspect` describes the
//! table `inspect_table` finds at the selection (`null`: none); `tables`
//! lists `[columns, rows]` of each table `inspect_tables` finds in the note.
mod random;
mod surface;
mod work;

use super::super::command::Command;
use super::super::Engine;
use super::ok;
use crate::{
    DisplayOffset, DisplayRange, EditorError, InputAction, ParagraphKey, TableAlignment,
    TableCommand, TableKey, TableOutcome,
};
use serde_json::Value;
use std::ops::Range;

const CASES: &str = include_str!("../../../../tests/fixtures/engine/tables.json");

/// Source text and the source selection its markers stand for.
fn marked(text: &str) -> (String, Range<usize>) {
    let mut source = String::new();
    let (mut start, mut end) = (None, None);
    for ch in text.chars() {
        match ch {
            '‸' => {
                start = Some(source.len());
                end = Some(source.len());
            }
            '«' => start = Some(source.len()),
            '»' => end = Some(source.len()),
            _ => source.push(ch),
        }
    }
    let start = start.expect("a selection marker");
    (source, start..end.expect("a selection end"))
}

fn display(engine: &Engine, source: &Range<usize>) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(engine.display_of(source.start)),
        end: DisplayOffset(engine.display_of(source.end)),
    }
}

fn open(before: &str) -> Engine {
    let (source, selection) = marked(before);
    let mut engine = Engine::open(&source);
    engine.land(selection, None);
    engine
}

fn table_key(name: &str) -> Option<TableKey> {
    Some(match name {
        "Tab" => TableKey::Tab,
        "ShiftTab" => TableKey::ShiftTab,
        "Enter" => TableKey::Enter,
        "ShiftEnter" => TableKey::ShiftEnter,
        "ModEnter" => TableKey::ModEnter,
        _ => return None,
    })
}

fn paragraph_key(name: &str) -> ParagraphKey {
    match name {
        "Enter" => ParagraphKey::Enter,
        "ShiftEnter" => ParagraphKey::ShiftEnter,
        "Tab" => ParagraphKey::Tab,
        "ShiftTab" => ParagraphKey::ShiftTab,
        "Backspace" => ParagraphKey::Backspace,
        "Delete" => ParagraphKey::Delete,
        other => panic!("unknown key {other}"),
    }
}

fn table_command(name: &str) -> Option<TableCommand> {
    Some(match name {
        "InsertRowAbove" => TableCommand::InsertRowAbove,
        "InsertRowBelow" => TableCommand::InsertRowBelow,
        "DeleteRow" => TableCommand::DeleteRow,
        "InsertColumnLeft" => TableCommand::InsertColumnLeft,
        "InsertColumnRight" => TableCommand::InsertColumnRight,
        "DeleteColumn" => TableCommand::DeleteColumn,
        _ => return None,
    })
}

/// Run `command` at the engine's selection: whether it edited the note.
pub(super) fn run(engine: &mut Engine, command: &str) -> Result<bool, EditorError> {
    let revision = engine.revision();
    let selection = engine.selection();
    if let Some(key) = table_key(command) {
        return Ok(matches!(
            engine.press_table_key(revision, key, &mut ok)?,
            Some(TableOutcome::Edited(_))
        ));
    }
    if let Some(command) = table_command(command) {
        return Ok(engine
            .run_table_command(revision, selection, command, &mut ok)?
            .is_some());
    }
    if let Some(key) = command.strip_prefix("key ") {
        let change = engine.key(revision, selection, paragraph_key(key), &mut ok)?;
        return Ok(change.is_some_and(|change| change.revision != revision));
    }
    if let Some(text) = command.strip_prefix("type ") {
        engine.replace(revision, selection, text, InputAction::Typing, &mut ok)?;
        return Ok(engine.revision() != revision);
    }
    if let Some(text) = command.strip_prefix("service ") {
        engine.replace(revision, selection, text, InputAction::Isolated, &mut ok)?;
        return Ok(engine.revision() != revision);
    }
    if let Some(text) = command.strip_prefix("paste ") {
        let change = engine.run(
            revision,
            |engine: &Engine| -> Result<Option<Command>, EditorError> {
                engine.cell_paste(selection, text)
            },
            &mut ok,
        )?;
        return Ok(change.is_some());
    }
    panic!("unknown command {command}");
}

fn check_edit(case: &Value) {
    let name = case["name"].as_str().unwrap();
    let before = case["before"].as_str().unwrap();
    let command = case["command"].as_str().unwrap();
    let mut engine = open(before);
    let (source, _) = marked(before);
    let selection = engine.selection();
    let result = run(&mut engine, command);
    if let Some(error) = case.get("error") {
        assert_eq!(
            format!("{:?}", result.expect_err(name)),
            error.as_str().unwrap(),
            "{name}"
        );
        assert_eq!(
            engine.source_text(),
            source,
            "{name}: an error changes nothing"
        );
        return;
    }
    let edited = result.unwrap_or_else(|error| panic!("{name}: {error:?}"));
    let after = &case["after"];
    if after.is_null() {
        assert!(!edited, "{name}: nothing changes");
        assert_eq!(engine.source_text(), source, "{name}: nothing changes");
        assert_eq!(engine.selection(), selection, "{name}: the selection stays");
        assert!(!engine.can_undo(), "{name}: no history");
        return;
    }
    let (want, want_selection) = marked(after.as_str().unwrap());
    assert_eq!(engine.source_text(), want, "{name}");
    assert_eq!(
        engine.selection(),
        display(&engine, &want_selection),
        "{name}: selection"
    );
    assert_eq!(edited, want != source, "{name}: edited");
    // The view after the command equals a fresh read of its text.
    assert_eq!(
        engine.display_text(),
        Engine::open(&want).display_text(),
        "{name}: display"
    );
    if !edited {
        assert!(!engine.can_undo(), "{name}: a move leaves no history");
        return;
    }
    let after_selection = engine.selection();
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), source, "{name}: undo");
    assert_eq!(engine.selection(), selection, "{name}: undo selection");
    assert!(!engine.can_undo(), "{name}: one undo step");
    engine.redo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), want, "{name}: redo");
    assert_eq!(
        engine.selection(),
        after_selection,
        "{name}: redo selection"
    );
}

fn alignment(name: &str) -> TableAlignment {
    match name {
        "Left" => TableAlignment::Left,
        "Center" => TableAlignment::Center,
        "Right" => TableAlignment::Right,
        _ => TableAlignment::None,
    }
}

fn check_inspect(case: &Value) {
    let name = case["name"].as_str().unwrap();
    let engine = open(case["before"].as_str().unwrap());
    let shown = engine.display_text();
    let text = |range: DisplayRange| shown[range.start.0..range.end.0].to_owned();
    let found = engine
        .inspect_table(engine.revision(), engine.selection())
        .unwrap();
    let want = &case["inspect"];
    let Some(table) = found else {
        assert!(want.is_null(), "{name}: a table");
        return;
    };
    assert!(!want.is_null(), "{name}: no table, found {table:?}");
    assert_eq!(
        table.columns,
        want["columns"].as_u64().unwrap() as usize,
        "{name}"
    );
    let alignments: Vec<TableAlignment> = want["alignments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|name| alignment(name.as_str().unwrap()))
        .collect();
    assert_eq!(table.alignments, alignments, "{name}: alignments");
    let cells: Vec<Vec<String>> = table
        .rows
        .iter()
        .map(|row| row.iter().map(|cell| text(cell.content)).collect())
        .collect();
    let want_cells: Vec<Vec<String>> = serde_json::from_value(want["rows"].clone()).unwrap();
    assert_eq!(cells, want_cells, "{name}: cells");
    for (index, row) in table.rows.iter().enumerate() {
        for (column, cell) in row.iter().enumerate() {
            assert_eq!((cell.row, cell.column), (index, column), "{name}");
            let source = cell.source.start.0..cell.source.end.0;
            assert_eq!(display(&engine, &source), cell.content, "{name}: source");
        }
    }
    let lines: Vec<String> = table.row_lines.iter().map(|line| text(*line)).collect();
    if let Some(want_lines) = want.get("lines") {
        let want_lines: Vec<String> = serde_json::from_value(want_lines.clone()).unwrap();
        assert_eq!(lines, want_lines, "{name}: row lines");
    }
    if let Some(delimiter) = want.get("delimiter") {
        assert_eq!(
            text(table.delimiter_line.unwrap()),
            delimiter.as_str().unwrap(),
            "{name}: delimiter line"
        );
    }
    let focus = table.focus.map(|focus| vec![focus.row, focus.column]);
    let want_focus: Option<Vec<usize>> = serde_json::from_value(want["focus"].clone()).unwrap();
    assert_eq!(focus, want_focus, "{name}: focus");
    if let Some(controls) = want.get("controls") {
        let found = table.controls.expect("controls with a focus");
        let on: Vec<&str> = [
            ("above", found.insert_row_above),
            ("below", found.insert_row_below),
            ("delete row", found.delete_row),
            ("left", found.insert_column_left),
            ("right", found.insert_column_right),
            ("delete column", found.delete_column),
        ]
        .into_iter()
        .filter(|(_, on)| *on)
        .map(|(name, _)| name)
        .collect();
        let want: Vec<String> = serde_json::from_value(controls.clone()).unwrap();
        assert_eq!(on, want, "{name}: controls");
    }
    // `inspect_tables` over the table finds the same table.
    let all = engine
        .inspect_tables(engine.revision(), table.display)
        .unwrap();
    assert_eq!(all.len(), 1, "{name}");
    assert_eq!(all[0].rows, table.rows, "{name}");
}

fn check_tables(case: &Value) {
    let name = case["name"].as_str().unwrap();
    let engine = open(case["before"].as_str().unwrap());
    let whole = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(engine.display_len()),
    };
    let found: Vec<(usize, usize)> = engine
        .inspect_tables(engine.revision(), whole)
        .unwrap()
        .iter()
        .map(|table| (table.columns, table.rows.len()))
        .collect();
    let want: Vec<(usize, usize)> = serde_json::from_value(case["tables"].clone()).unwrap();
    assert_eq!(found, want, "{name}");
}

#[test]
fn the_literal_table_cases() {
    let file: Value = serde_json::from_str(CASES).unwrap();
    let cases = file["cases"].as_array().unwrap();
    for case in cases {
        if case.get("inspect").is_some() {
            check_inspect(case);
        } else if case.get("tables").is_some() {
            check_tables(case);
        } else {
            check_edit(case);
        }
    }
    assert!(cases.len() >= 60, "{} cases", cases.len());
}

pub(super) fn total(work: &crate::EditWork) -> usize {
    work.materialized_source_bytes + work.parsed_source_bytes + work.link_metadata_items
}

pub(super) fn caret(at: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(at),
        end: DisplayOffset(at),
    }
}

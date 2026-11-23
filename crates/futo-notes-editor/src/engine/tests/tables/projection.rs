//! A projection's table facts equal what table inspection reads from the
//! whole table, wherever the projection cuts it.
use super::super::super::Engine;
use super::super::range;
use crate::{BlockDescription, TableDescription, TableLineRole};

const NOTES: &[&str] = &[
    "| a | b |\n| --- | --- |\n| c | d |",
    "intro\n| a |\n|:-:|\n| b | c | d |\n| e |\nafter",
    "| **a** | `p\\|q` |\n| - | --: |\n| x \\| y | [l](u) |\n",
    "| a | b |\r\n| :- | - |\r\n|  | x |\r\n\r\n| c |\r\n| - |\r\n| d |",
    "| h |\n|---|",
    "| é | 😀 |\n| - | - |\n| x | 日 |\n| y",
    "| a |\n|---|\n| b |\n\n```\n| c |\n```\n| d |\n|---|",
];

fn table_line(block: &BlockDescription) -> &crate::TableLineDescription {
    block.table.as_ref().expect("a table line")
}

/// The projection of the whole note describes each table and each of its
/// lines as inspection reads them.
pub(in crate::engine::tests) fn check_table_facts(engine: &Engine, context: &str) {
    let whole = range(0, engine.display_len());
    let tables = engine.inspect_tables(engine.revision(), whole).unwrap();
    check(engine, &tables, context);
}

fn check(engine: &Engine, tables: &[TableDescription], context: &str) {
    let whole = range(0, engine.display_len());
    let slice = engine.projection(engine.revision(), whole);
    assert_eq!(slice.tables.len(), tables.len(), "{context}");
    let display = engine.display_text();
    for (table, described) in tables.iter().zip(&slice.tables) {
        assert_eq!(described.range, table.display, "{context}");
        assert_eq!(described.columns, table.columns, "{context}");
        assert_eq!(described.alignments, table.alignments, "{context}");
        let line_at = |start: usize| {
            slice
                .blocks
                .iter()
                .find(|block| block.range.start.0 == start)
                .map(table_line)
                .expect("a described table line")
        };
        for (row, line) in table.row_lines.iter().enumerate() {
            let described = line_at(line.start.0);
            let role = if row == 0 {
                TableLineRole::Header
            } else {
                TableLineRole::Row
            };
            assert_eq!((described.role, described.row), (role, row), "{context}");
            let cells: Vec<_> = table.rows[row].iter().map(|cell| cell.content).collect();
            assert_eq!(described.cells, cells, "{context}");
            for pipe in &described.pipes {
                assert_eq!(&display[pipe.0..pipe.0 + 1], "|", "{context}");
            }
        }
        let delimiter = table.delimiter_line.expect("a delimiter row");
        let described = line_at(delimiter.start.0);
        assert_eq!(
            (described.role, described.row),
            (TableLineRole::Delimiter, 0),
            "{context}"
        );
        // A projection of any one line describes its whole table.
        for line in table.row_lines.iter().chain([&delimiter]) {
            let part = engine.projection(engine.revision(), range(line.start.0, line.start.0));
            assert_eq!(
                part.tables,
                vec![described_table(&slice, table)],
                "{context}"
            );
        }
    }
    let plain = slice.blocks.iter().filter(|block| block.table.is_none());
    let lines_in_tables = slice.blocks.len() - plain.count();
    let table_lines: usize = tables.iter().map(|table| table.row_lines.len() + 1).sum();
    assert_eq!(lines_in_tables, table_lines, "{context}");
}

fn described_table(
    slice: &crate::ProjectionSlice,
    table: &TableDescription,
) -> crate::TableBlockDescription {
    slice
        .tables
        .iter()
        .find(|described| described.range == table.display)
        .cloned()
        .expect("the table")
}

#[test]
fn a_projection_describes_tables_as_inspection_reads_them() {
    for note in NOTES {
        let engine = Engine::open(note);
        let whole = range(0, engine.display_len());
        let tables = engine.inspect_tables(engine.revision(), whole).unwrap();
        check(&engine, &tables, &format!("{note:?}"));
    }
}

/// Typing a delimiter row makes a table of the lines around it, and every
/// edit after that keeps the projection equal to inspection.
#[test]
fn typed_tables_project_as_inspected() {
    let mut engine = Engine::open("| a | b |\n\n| c |");
    for (at, text, count) in [
        (9, "\n|---|:-:|", 1),
        (19, "\n| x | y | z | w |", 1),
        (11, ":", 1),
        (0, "x", 0),
    ] {
        let revision = engine.revision();
        engine
            .replace(
                revision,
                range(at, at),
                text,
                crate::InputAction::Isolated,
                &mut super::super::ok,
            )
            .unwrap();
        let whole = range(0, engine.display_len());
        let tables = engine.inspect_tables(engine.revision(), whole).unwrap();
        assert_eq!(tables.len(), count, "{:?}", engine.source_text());
        check(&engine, &tables, &engine.source_text());
    }
}

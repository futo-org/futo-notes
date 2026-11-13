//! Tables: inspection, table keys and table commands.
//!
//! A table is read from the line readings: a header, the delimiter row under
//! it and the rows after that (the reader decides which lines those are).
//! Each line's cells are read from that line alone. The table is as wide as
//! its widest row; a shorter row is padded, and a cell past the header is a
//! column like any other. Cells project onto the note's own display, so one
//! selection serves the note and a cell view.
mod keys;
mod paste;
mod structure;

use super::super::line::Entry;
use super::super::Engine;
use crate::lines::{self, Kind, TableRole};
use crate::{
    DisplayOffset, DisplayRange, EditorError, Revision, SourceOffset, SourceRange, TableAlignment,
    TableCell, TableControls, TableDescription, TableFocus,
};
use std::ops::Range;

/// One line of a table, in source offsets.
pub(in crate::engine) struct Row {
    /// Line index.
    pub(in crate::engine) index: usize,
    pub(in crate::engine) start: usize,
    /// End of the line's text, before its ending.
    pub(in crate::engine) end: usize,
    /// The line's ending; empty on the note's last line.
    pub(in crate::engine) ending: String,
    /// Each cell's text between its pipes, untrimmed.
    pub(in crate::engine) cells: Vec<Range<usize>>,
    /// Each cell's content: its text without edge spaces and tabs. An empty
    /// cell's content is the point after its first padding space, where
    /// typing lands.
    pub(in crate::engine) contents: Vec<Range<usize>>,
    /// Every pipe that bounds a cell, in order; an escaped pipe is text.
    pub(in crate::engine) pipes: Vec<usize>,
}

impl Row {
    fn read(entry: &Entry, index: usize, start: usize) -> Self {
        let body = entry.body();
        let cells = lines::table::cells(body);
        // A table line starts with its first pipe.
        let mut pipes = vec![start];
        pipes.extend(
            cells
                .iter()
                .filter(|cell| body.as_bytes().get(cell.end) == Some(&b'|'))
                .map(|cell| start + cell.end),
        );
        let contents = cells
            .iter()
            .map(|cell| {
                let content = lines::table::trimmed(body, cell);
                let content = if content.is_empty() {
                    let padded = body[cell.clone()].starts_with([' ', '\t']);
                    let at = cell.start + usize::from(padded);
                    at..at
                } else {
                    content
                };
                start + content.start..start + content.end
            })
            .collect();
        Self {
            index,
            start,
            end: start + entry.body_len(),
            ending: entry.ending().to_owned(),
            cells: cells
                .into_iter()
                .map(|cell| start + cell.start..start + cell.end)
                .collect(),
            contents,
            pipes,
        }
    }

    /// Start of the next line.
    fn next(&self) -> usize {
        self.end + self.ending.len()
    }

    /// Whether the last cell runs to the line's end with no pipe after it.
    fn open_ended(&self) -> bool {
        self.cells
            .last()
            .is_some_and(|cell| self.pipes.last() != Some(&cell.end))
    }

    /// Where text appended after the row's last pipe goes.
    fn after_last_pipe(&self) -> usize {
        self.pipes.last().map_or(self.end, |pipe| pipe + 1)
    }
}

/// A table read from its header to its last row.
pub(in crate::engine) struct Table {
    /// Header, delimiter row, then body rows.
    pub(in crate::engine) lines: Vec<Row>,
    /// Cells in the widest row (the delimiter row aside).
    pub(in crate::engine) width: usize,
    pub(in crate::engine) alignments: Vec<TableAlignment>,
    /// Source bytes read to find it.
    pub(in crate::engine) read: usize,
}

impl Table {
    /// Rows, header included; the delimiter row is not a row.
    pub(in crate::engine) fn rows(&self) -> usize {
        self.lines.len() - 1
    }

    pub(in crate::engine) fn row(&self, row: usize) -> &Row {
        &self.lines[if row == 0 { 0 } else { row + 1 }]
    }

    pub(in crate::engine) fn last(&self) -> &Row {
        self.lines.last().expect("a header and a delimiter row")
    }

    fn delimiter(&self) -> &Row {
        &self.lines[1]
    }

    /// The line ending a new line next to `line` takes: its own, else any
    /// table line's, else LF.
    fn ending(&self, line: &Row) -> String {
        if !line.ending.is_empty() {
            return line.ending.clone();
        }
        self.lines
            .iter()
            .find(|line| !line.ending.is_empty())
            .map_or_else(|| "\n".to_owned(), |line| line.ending.clone())
    }

    /// An empty row as wide as the table.
    fn blank_row(&self) -> String {
        format!("|{}", "  |".repeat(self.width))
    }

    pub(in crate::engine) fn controls(&self, row: usize) -> TableControls {
        TableControls {
            insert_row_above: row >= 1,
            insert_row_below: true,
            delete_row: row >= 1 && self.rows() >= 3,
            insert_column_left: true,
            insert_column_right: true,
            delete_column: self.width > 1,
        }
    }
}

fn alignment(cell: &str) -> TableAlignment {
    let cell = cell.trim_matches([' ', '\t']);
    match (cell.starts_with(':'), cell.len() > 1 && cell.ends_with(':')) {
        (true, true) => TableAlignment::Center,
        (true, false) => TableAlignment::Left,
        (false, true) => TableAlignment::Right,
        (false, false) => TableAlignment::None,
    }
}

/// A cell a display range lies in.
struct Cell {
    table: Table,
    row: usize,
    column: usize,
}

fn role(entry: &Entry) -> Option<TableRole> {
    match entry.line.kind {
        Kind::Table { role, .. } => Some(role),
        _ => None,
    }
}

impl Engine {
    /// The table holding line `index`.
    pub(in crate::engine) fn table_at(&self, index: usize) -> Option<Table> {
        let mut header = index;
        while role(self.line(header))? != TableRole::Header {
            header = header.checked_sub(1)?;
        }
        let mut lines = Vec::new();
        let mut start = self.line_start(header);
        let mut read = 0;
        for (offset, entry) in self.store.iter_from(header).enumerate() {
            match role(entry) {
                Some(TableRole::Header) if offset > 0 => break,
                Some(_) => {}
                None => break,
            }
            read += entry.text.len();
            lines.push(Row::read(entry, header + offset, start));
            start += entry.text.len();
        }
        if lines.len() < 2 {
            return None;
        }
        let width = lines
            .iter()
            .enumerate()
            .filter(|(at, _)| *at != 1)
            .map(|(_, line)| line.cells.len())
            .max()
            .unwrap_or(0);
        let delimiter = &lines[1];
        let text = self.line(delimiter.index).body();
        let alignments = (0..width)
            .map(|column| {
                delimiter
                    .cells
                    .get(column)
                    .map_or(TableAlignment::None, |cell| {
                        alignment(&text[cell.start - delimiter.start..cell.end - delimiter.start])
                    })
            })
            .collect();
        Some(Table {
            lines,
            width,
            alignments,
            read,
        })
    }

    /// A text service's or dictation's `text` over display `range` inside
    /// one cell, with its line breaks made spaces as a paste's are
    /// (`flatten_for_cell`), so it stays in the cell. Typing is not shaped:
    /// a typed line break breaks the row. `None` when `text` lands as given.
    pub(crate) fn cell_service_text(&self, range: DisplayRange, text: &str) -> Option<String> {
        if !text.contains(['\n', '\r']) {
            return None;
        }
        self.cell_at(range)?;
        Some(crate::table::flatten_for_cell(text))
    }

    /// The cell display `range` lies in: both ends on one header or body
    /// line, inside one cell's text between its pipes.
    fn cell_at(&self, range: DisplayRange) -> Option<Cell> {
        let (index, column) = self.column_at(range)?;
        let table = self.table_at(index)?;
        let row = index - table.lines[0].index;
        Some(Cell {
            table,
            row: row.saturating_sub(1),
            column,
        })
    }

    /// The line and column of the cell display `range` lies in, as
    /// `cell_at` finds it, reading only that line.
    fn column_at(&self, range: DisplayRange) -> Option<(usize, usize)> {
        let source = self.source_selection(range);
        let index = self.line_of(source.start);
        let entry = self.line(index);
        if !matches!(role(entry)?, TableRole::Header | TableRole::Row) {
            return None;
        }
        let row = Row::read(entry, index, self.line_start(index));
        if source.end > row.end {
            return None;
        }
        let column = row
            .cells
            .iter()
            .position(|cell| cell.start <= source.start && source.end <= cell.end)?;
        Some((index, column))
    }

    /// Whether display `range` touches a table line without lying inside
    /// one cell: over a pipe, on the delimiter row, across cells, or before
    /// a row's first pipe or past its last.
    pub(crate) fn outside_one_cell(&self, range: DisplayRange) -> bool {
        self.lines_of(range)
            .any(|index| role(self.line(index)).is_some())
            && self.column_at(range).is_none()
    }

    pub(crate) fn display_range(&self, source: Range<usize>) -> DisplayRange {
        DisplayRange {
            start: DisplayOffset(self.display_of(source.start)),
            end: DisplayOffset(self.display_of(source.end)),
        }
    }

    fn describe(&self, table: &Table, focus: Option<(usize, usize)>) -> TableDescription {
        let rows = (0..table.rows())
            .map(|row| {
                let line = table.row(row);
                line.contents
                    .iter()
                    .enumerate()
                    .map(|(column, content)| TableCell {
                        row,
                        column,
                        source: SourceRange {
                            start: SourceOffset(content.start),
                            end: SourceOffset(content.end),
                        },
                        content: self.display_range(content.clone()),
                    })
                    .collect()
            })
            .collect();
        let first = table.lines[0].start;
        let last = table.last().end;
        TableDescription {
            source: SourceRange {
                start: SourceOffset(first),
                end: SourceOffset(last),
            },
            display: self.display_range(first..last),
            columns: table.width,
            alignments: table.alignments.clone(),
            rows,
            focus: focus.map(|(row, column)| TableFocus { row, column }),
            controls: focus.map(|(row, _)| table.controls(row)),
            row_lines: (0..table.rows())
                .map(|row| {
                    let line = table.row(row);
                    self.display_range(line.start..line.end)
                })
                .collect(),
            delimiter_line: Some(
                self.display_range(table.delimiter().start..table.delimiter().end),
            ),
        }
    }

    /// The table at display `range`'s start, with its focused cell and the
    /// commands that apply when the range lies inside one cell.
    pub(crate) fn inspect_table(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Option<TableDescription>, EditorError> {
        self.check_revision(expected)?;
        self.check_display_range(range)?;
        if let Some(cell) = self.cell_at(range) {
            return Ok(Some(
                self.describe(&cell.table, Some((cell.row, cell.column))),
            ));
        }
        let index = self.line_of(self.source_selection(range).start);
        Ok(self
            .table_at(index)
            .map(|table| self.describe(&table, None)))
    }

    /// Every table a line in display `range` lies in, in order.
    pub(crate) fn inspect_tables(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Vec<TableDescription>, EditorError> {
        self.check_revision(expected)?;
        self.check_display_range(range)?;
        let focus = self
            .cell_at(range)
            .map(|cell| (cell.table.lines[0].index, cell.row, cell.column));
        let lines = self.lines_of(range);
        let mut tables = Vec::new();
        let mut index = lines.start;
        while index < lines.end {
            let Some(table) = role(self.line(index)).and_then(|_| self.table_at(index)) else {
                index += 1;
                continue;
            };
            let header = table.lines[0].index;
            let focus = focus
                .filter(|(at, _, _)| *at == header)
                .map(|(_, row, column)| (row, column));
            index = table.last().index + 1;
            tables.push(self.describe(&table, focus));
        }
        Ok(tables)
    }
}

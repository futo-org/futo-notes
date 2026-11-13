//! Keys in a table. Tab, Shift+Tab and Enter move between cells (a move is
//! a selection change with no edit); entering a cell a short row lacks gives
//! the row the cells up to it, and leaving the last row appends one.
//! Backspace and Delete never remove a pipe or the line break between two of
//! a table's lines.
use super::super::super::command::{Command, Edit};
use super::super::super::Engine;
use super::{Cell, Row, Table};
use crate::lines::{Kind, TableRole};
use crate::{
    CaretDirection, DisplayRange, EditorError, ParagraphKey, Revision, SelectionChange, SourceEdit,
    TableKey, TableOutcome, ViewChange,
};
use std::ops::Range;

type Accept<'a> = &'a mut dyn FnMut(&SourceEdit) -> Result<(), String>;

/// A command that only moves the selection to `selection`.
fn moved(line: usize, selection: Range<usize>) -> Command {
    Command::new(Vec::new(), line..line + 1, selection)
}

impl Engine {
    /// The paragraph keys a table claims. Enter and Shift+Enter in a cell
    /// are the table's Enter, Tab and Shift+Tab its Tab keys; Backspace and
    /// Delete that would remove a pipe or join two of its lines do nothing.
    pub(crate) fn table_key(
        &self,
        range: DisplayRange,
        key: ParagraphKey,
    ) -> Result<Option<Command>, EditorError> {
        let key = match key {
            ParagraphKey::Enter | ParagraphKey::ShiftEnter => TableKey::Enter,
            ParagraphKey::Tab => TableKey::Tab,
            ParagraphKey::ShiftTab => TableKey::ShiftTab,
            ParagraphKey::Backspace | ParagraphKey::BackspaceJoiningHeading => {
                return Ok(self.kept_structure(range, CaretDirection::Backward));
            }
            ParagraphKey::Delete => {
                return Ok(self.kept_structure(range, CaretDirection::Forward));
            }
        };
        Ok(self.cell_key(range, key).map(|(command, _)| command))
    }

    /// A table key with display `range` in a cell, and the source bytes read
    /// to find the table. `None` outside every cell, and for Shift+Tab in
    /// the first cell (the host's).
    fn cell_key(&self, range: DisplayRange, key: TableKey) -> Option<(Command, usize)> {
        let Cell { table, row, column } = self.cell_at(range)?;
        let (rows, width) = (table.rows(), table.width);
        let command = match key {
            TableKey::Tab if column + 1 < width => enter_cell(&table, row, column + 1),
            TableKey::Tab if row + 1 < rows => enter_cell(&table, row + 1, 0),
            TableKey::Tab => append_row(&table, 0),
            TableKey::ShiftTab if column > 0 => enter_cell(&table, row, column - 1),
            TableKey::ShiftTab if row > 0 => enter_cell(&table, row - 1, width - 1),
            TableKey::ShiftTab => return None,
            // A cell holds one line: Shift+Enter moves on as Enter does.
            TableKey::Enter | TableKey::ShiftEnter if row + 1 < rows => {
                enter_cell(&table, row + 1, column)
            }
            TableKey::Enter | TableKey::ShiftEnter => append_row(&table, column),
            TableKey::ModEnter => self.leave_table(&table),
        };
        Some((command, table.read))
    }

    /// The empty line after the table, written when the line after it is
    /// not already empty.
    fn leave_table(&self, table: &Table) -> Command {
        let last = table.last();
        let eol = table.ending(last);
        if last.ending.is_empty() {
            let caret = last.end + eol.len();
            return Command::new(
                vec![Edit::insert(last.end, eol)],
                last.index..last.index + 1,
                caret..caret,
            );
        }
        let next = last.next();
        if self.line(last.index + 1).body().is_empty() {
            return moved(last.index + 1, next..next);
        }
        Command::new(
            vec![Edit::insert(next, eol)],
            last.index..last.index + 1,
            next..next,
        )
    }

    /// Backspace or Delete at a collapsed caret that would remove a pipe of
    /// a table line, or the line break between two lines of one table: the
    /// caret stays where it is.
    fn kept_structure(&self, range: DisplayRange, direction: CaretDirection) -> Option<Command> {
        if range.start != range.end {
            return None;
        }
        let at = range.start.0;
        let stop = self.grapheme_stop(at, direction);
        let (low, high) = (at.min(stop), at.max(stop));
        if low == high {
            return None;
        }
        let shown = self.display_slice(low..high);
        let source = self.source_span(low).1;
        let index = self.line_of(source);
        let entry = self.line(index);
        let kept = match shown.as_str() {
            "\n" | "\r\n" => {
                index + 1 < self.line_count()
                    && matches!(
                        self.line(index + 1).line.kind,
                        Kind::Table {
                            role: TableRole::Delimiter | TableRole::Row,
                            ..
                        }
                    )
            }
            "|" => {
                matches!(entry.line.kind, Kind::Table { .. })
                    && Row::read(entry, index, self.line_start(index))
                        .pipes
                        .contains(&source)
            }
            _ => false,
        };
        let caret = self.source_selection(range);
        kept.then(|| moved(index, caret))
    }

    /// Select source `range` with no edit, as a view change at the same
    /// revision.
    pub(crate) fn moved_view(
        &mut self,
        expected: Revision,
        range: Range<usize>,
    ) -> Result<ViewChange, EditorError> {
        self.move_to(expected, range)?;
        Ok(self.unchanged())
    }

    fn move_to(
        &mut self,
        expected: Revision,
        range: Range<usize>,
    ) -> Result<SelectionChange, EditorError> {
        let display = self.display_range(range);
        self.select(expected, display)
    }

    /// `table_key` on the surface: a key with the selection in a cell, as a
    /// selection move or one accepted edit. `None` outside every cell.
    pub(crate) fn press_table_key(
        &mut self,
        expected: Revision,
        key: TableKey,
        accept: Accept,
    ) -> Result<Option<TableOutcome>, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let Some((command, read)) = self.cell_key(self.selection, key) else {
            return Ok(None);
        };
        if command.edits.is_empty() {
            return self
                .move_to(expected, command.selection)
                .map(|moved| Some(TableOutcome::Selected(moved)));
        }
        let change = self.run(expected, |_| Ok(Some(command)), accept)?;
        Ok(change.map(|change| {
            let mut view = self.view(change);
            view.work.parsed_source_bytes += read;
            TableOutcome::Edited(Box::new(view))
        }))
    }
}

/// Select the content of cell `(row, column)`. A row that lacks the cell
/// gains empty cells up to it first, and the caret enters it; a header that
/// gains cells gives its delimiter row the same count, so the two still
/// agree.
fn enter_cell(table: &Table, row: usize, column: usize) -> Command {
    let line = table.row(row);
    if let Some(content) = line.contents.get(column) {
        return moved(line.index, content.clone());
    }
    let (at, text) = fill(line, column + 1, "  ");
    let caret = at + text.len() - 2;
    let mut edits = vec![Edit::insert(at, text)];
    let mut named = line.index..line.index + 1;
    let delimiter = table.delimiter();
    if row == 0 && delimiter.cells.len() == line.cells.len() {
        let (at, text) = fill(delimiter, column + 1, " --- ");
        edits.push(Edit::insert(at, text));
        named.end += 1;
    }
    Command::new(edits, named, caret..caret)
}

/// Where to write, and what, to give `line` cells up to `count`.
fn fill(line: &Row, count: usize, cell: &str) -> (usize, String) {
    let cells = format!("{cell}|").repeat(count - line.cells.len());
    if line.open_ended() {
        (line.end, format!("|{cells}"))
    } else {
        (line.after_last_pipe(), cells)
    }
}

/// An empty row after the last, with the caret in its cell `column`.
fn append_row(table: &Table, column: usize) -> Command {
    let last = table.last();
    let eol = table.ending(last);
    let blank = table.blank_row();
    let (at, text, start) = if last.ending.is_empty() {
        (last.end, format!("{eol}{blank}"), last.end + eol.len())
    } else {
        (last.next(), format!("{blank}{eol}"), last.next())
    };
    let caret = start + 3 * column + 2;
    Command::new(
        vec![Edit::insert(at, text)],
        last.index..last.index + 1,
        caret..caret,
    )
}

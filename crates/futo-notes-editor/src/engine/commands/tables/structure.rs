//! Row and column commands. Each edits table lines only, names every line
//! it changes, and inserts or removes whole cells at their pipes, so the
//! bytes of every untouched cell, the alignment markers and a missing final
//! line ending stay as they were.
use super::super::super::command::{Command, Edit};
use super::super::super::Engine;
use super::{Cell, Row, Table};
use crate::{DisplayRange, EditorError, Revision, SourceEdit, TableCommand, ViewChange};
use std::ops::Range;

type Accept<'a> = &'a mut dyn FnMut(&SourceEdit) -> Result<(), String>;

impl Engine {
    /// A table command for the cell display `range` lies in, and the source
    /// bytes read to find the table. `None` outside every cell, or when the
    /// command does not apply there (`TableControls`).
    fn table_structure(
        &self,
        range: DisplayRange,
        command: TableCommand,
    ) -> Option<(Command, usize)> {
        let Cell { table, row, column } = self.cell_at(range)?;
        let controls = table.controls(row);
        let allowed = match command {
            TableCommand::InsertRowAbove => controls.insert_row_above,
            TableCommand::InsertRowBelow => controls.insert_row_below,
            TableCommand::DeleteRow => controls.delete_row,
            TableCommand::InsertColumnLeft => controls.insert_column_left,
            TableCommand::InsertColumnRight => controls.insert_column_right,
            TableCommand::DeleteColumn => controls.delete_column,
        };
        if !allowed {
            return None;
        }
        let edits = match command {
            TableCommand::InsertRowAbove => insert_row(&table, table.row(row), false),
            // Below the header is below the delimiter row.
            TableCommand::InsertRowBelow if row == 0 => insert_row(&table, table.delimiter(), true),
            TableCommand::InsertRowBelow => insert_row(&table, table.row(row), true),
            TableCommand::DeleteRow => delete_row(&table, row),
            TableCommand::InsertColumnLeft => insert_column(&table, column),
            TableCommand::InsertColumnRight => insert_column(&table, column + 1),
            TableCommand::DeleteColumn => delete_column(&table, column),
        };
        let mut named: Vec<Range<usize>> = Vec::new();
        for (lines, _) in &edits {
            match named.last_mut() {
                Some(last) if last.end >= lines.start => last.end = last.end.max(lines.end),
                _ => named.push(lines.clone()),
            }
        }
        let mut built = Command {
            edits: edits.into_iter().map(|(_, edit)| edit).collect(),
            lines: named,
            selection: 0..0,
            affinity: None,
            typed: false,
        };
        // A cell keeps a caret or selection it holds when the command keeps
        // the cell; otherwise the caret goes to the start of the cell the
        // focus lands on.
        let cell = table.row(row).cells[column].clone();
        let current = self.source_selection(self.selection);
        let right = command == TableCommand::InsertColumnRight;
        built.selection = match command {
            TableCommand::DeleteRow | TableCommand::DeleteColumn => {
                let at = match deleted_focus(&table, row, column, command) {
                    Focus::Kept(at) => built.map(at, false),
                    // Inside the emptied cell's two spaces.
                    Focus::Emptied(at) => built.map(at, false) + 1,
                };
                at..at
            }
            _ if cell.start <= current.start && current.end <= cell.end => {
                built.map(current.start, !right)..built.map(current.end, !right)
            }
            _ => {
                let content = table.row(row).contents[column].start;
                let at = built.map(content, !right);
                at..at
            }
        };
        // One replacement from the first edit to the last: the bytes between
        // them are written back as they were, and the table is read once.
        if built.edits.len() > 1 {
            let start = built.edits[0].range.start;
            let end = built.edits.last().expect("edits").range.end;
            let old = self.source_slice(start..end);
            let mut text = String::with_capacity(old.len());
            let mut at = start;
            for edit in &built.edits {
                text.push_str(&old[at - start..edit.range.start - start]);
                text.push_str(&edit.text);
                at = edit.range.end;
            }
            built.edits = vec![Edit::new(start..end, text)];
        }
        Some((built, table.read))
    }

    /// `table_command` on the surface: one accepted edit and one undo step,
    /// or `None` when nothing applies.
    pub(crate) fn run_table_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: TableCommand,
        accept: Accept,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        self.check_display_range(range)?;
        let Some((command, read)) = self.table_structure(range, command) else {
            return Ok(None);
        };
        let change = self.run(expected, |_| Ok(Some(command)), accept)?;
        Ok(change.map(|change| {
            let mut view = self.view(change);
            view.work.parsed_source_bytes += read;
            view
        }))
    }
}

/// An empty row above or below `line`, in the line's own ending.
fn insert_row(table: &Table, line: &Row, below: bool) -> Vec<(Range<usize>, Edit)> {
    let eol = table.ending(line);
    let blank = table.blank_row();
    let edit = match (below, line.ending.is_empty()) {
        (false, _) => Edit::insert(line.start, format!("{blank}{eol}")),
        (true, false) => Edit::insert(line.next(), format!("{blank}{eol}")),
        (true, true) => Edit::insert(line.end, format!("{eol}{blank}")),
    };
    vec![(line.index..line.index + 1, edit)]
}

/// The row's line with its ending; on the note's last line, the ending
/// before it.
fn delete_row(table: &Table, row: usize) -> Vec<(Range<usize>, Edit)> {
    let line = table.row(row);
    if !line.ending.is_empty() {
        return vec![(
            line.index..line.index + 1,
            Edit::new(line.start..line.next(), ""),
        )];
    }
    let above = &table.lines[row];
    vec![(
        above.index..line.index + 1,
        Edit::new(above.end..line.end, ""),
    )]
}

/// A new empty cell at `column` on every line that has a cell there or ends
/// right before it as one of the widest rows; a shorter row stays padded.
fn insert_column(table: &Table, column: usize) -> Vec<(Range<usize>, Edit)> {
    let mut edits = Vec::new();
    for (at, line) in table.lines.iter().enumerate() {
        let count = line.cells.len();
        let cell = if at == 1 { " --- " } else { "  " };
        let edit = if column < count {
            Edit::insert(line.cells[column].start, format!("{cell}|"))
        } else if column == count && count == table.width {
            if line.open_ended() {
                Edit::insert(line.end, format!("|{cell}|"))
            } else {
                Edit::insert(line.after_last_pipe(), format!("{cell}|"))
            }
        } else {
            continue;
        };
        edits.push((line.index..line.index + 1, edit));
    }
    edits
}

/// Cell `column` and one pipe beside it, on every line that has it: the
/// pipe after it, or for the last cell the pipe before it, unless no pipe
/// closes the last cell (the pipe before it then closes the cell left of
/// it). A line's only cell is emptied instead, so the row keeps its pipes;
/// a delimiter row keeps its only cell.
fn delete_column(table: &Table, column: usize) -> Vec<(Range<usize>, Edit)> {
    let mut edits = Vec::new();
    for (at, line) in table.lines.iter().enumerate() {
        let count = line.cells.len();
        if column >= count {
            continue;
        }
        let cell = line.cells[column].clone();
        let edit = if count == 1 {
            if at == 1 {
                continue;
            }
            Edit::new(cell, if line.open_ended() { "  |" } else { "  " })
        } else if column + 1 < count {
            Edit::new(cell.start..cell.end + 1, "")
        } else if line.open_ended() {
            Edit::new(cell, "")
        } else {
            Edit::new(cell.start - 1..cell.end, "")
        };
        edits.push((line.index..line.index + 1, edit));
    }
    edits
}

/// Where the caret goes after deleting the focused row or column, before
/// the command.
enum Focus {
    /// The start of a cell the command keeps.
    Kept(usize),
    /// The start of a cell the command empties.
    Emptied(usize),
}

/// The cell below the deleted row (above for the last row), or right of the
/// deleted column (left for the last column).
fn deleted_focus(table: &Table, row: usize, column: usize, command: TableCommand) -> Focus {
    let (line, column) = if command == TableCommand::DeleteRow {
        let target = if row + 1 < table.rows() {
            row + 1
        } else {
            row - 1
        };
        let line = table.row(target);
        (line, column.min(line.cells.len().saturating_sub(1)))
    } else {
        let line = table.row(row);
        let count = line.cells.len();
        if count == 1 {
            return Focus::Emptied(line.cells[0].start);
        }
        (
            line,
            if column + 1 < count {
                column + 1
            } else {
                column - 1
            },
        )
    };
    Focus::Kept(
        line.contents
            .get(column)
            .map_or(line.start + 1, |content| content.start),
    )
}

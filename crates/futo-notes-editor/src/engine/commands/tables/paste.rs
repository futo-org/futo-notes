//! Plain text pasted inside one table cell. The clipboard family calls
//! `cell_paste` first, so a paste in a cell stays in it.
use super::super::super::command::{Command, Edit};
use super::super::super::Engine;
use super::{role, Cell};
use crate::{DisplayRange, EditorError};

/// `text` as one cell's text: edge blank lines go, every other run of
/// whitespace holding a line break becomes one space, and a pipe is written
/// `\|` so it stays text.
fn cell_text(text: &str) -> String {
    let flat = crate::table::flatten_for_cell(text);
    let mut out = String::with_capacity(flat.len());
    let mut chars = flat.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                out.push(ch);
                out.extend(chars.next());
            }
            '|' => out.push_str("\\|"),
            _ => out.push(ch),
        }
    }
    out
}

impl Engine {
    /// The command pasting plain `text` over display `range` inside one
    /// cell. `Ok(None)` when `range` does not start on a table line;
    /// `InvalidRange` when it is not inside one cell; `UnrepresentableFormat`
    /// when the paste would still change the row's cells (a trailing `\`
    /// before the cell's closing pipe).
    pub(crate) fn cell_paste(
        &self,
        range: DisplayRange,
        text: &str,
    ) -> Result<Option<Command>, EditorError> {
        self.check_display_range(range)?;
        let index = self.line_of(self.source_selection(range).start);
        if role(self.line(index)).is_none() {
            return Ok(None);
        }
        let Some(Cell { table, row, column }) = self.cell_at(range) else {
            return Err(EditorError::InvalidRange);
        };
        let line = table.row(row);
        let cell = line.cells[column].clone();
        let plan = self.plan(self.outside_crlf(range), &cell_text(text));
        if plan.range.start < cell.start || plan.range.end > cell.end {
            return Err(EditorError::InvalidRange);
        }
        let body = self.line(line.index).body();
        let mut after = body.to_owned();
        after.replace_range(
            plan.range.start - line.start..plan.range.end - line.start,
            &plan.inserted,
        );
        if crate::lines::table::cells(&after).len() != line.cells.len() {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(Some(Command::new(
            vec![Edit::new(plan.range, plan.inserted)],
            line.index..line.index + 1,
            plan.caret..plan.caret,
        )))
    }
}

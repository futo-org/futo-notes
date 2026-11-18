//! The table command.
use super::super::super::command::Command;
use super::super::super::Engine;
use super::super::tables::{new_row, DELIMITER_CELL, EMPTY_CELL};
use super::{right_side, split};
use crate::lines::Kind;
use crate::DisplayRange;

impl Engine {
    /// Put an empty table of `rows` rows (the header included) and `columns`
    /// columns at the caret, the selection removed first, where a divider
    /// goes (`placed`): text before the caret stays on its line above it,
    /// text after it goes to a plain line below at the same quote depth, and
    /// a caret at a line's text start puts it above the whole line. A blank
    /// line becomes the table. A table is read only at column 0, so it is
    /// never quoted or in a list. A blank line goes between it and a table
    /// line above it or a `|` line below it, which would otherwise read as
    /// its rows. The caret lands in the header's first cell.
    pub(super) fn table(&self, range: DisplayRange, rows: u16, columns: u16) -> Option<Command> {
        if rows == 0 || columns == 0 {
            return None;
        }
        let (joined, after_front_matter) = self.placed(range)?;
        let text = joined.text.as_str();
        let line = &joined.line;
        let (left, right) = if line.kind == Kind::Divider || after_front_matter {
            (Some(text.to_owned()), String::new())
        } else if line.kind == Kind::Blank {
            (None, String::new())
        } else {
            let (at, closes, opens) = split(text, line, &joined.spans, joined.caret);
            if at <= line.content.start {
                (None, text.to_owned())
            } else if at == text.len() {
                (Some(text.to_owned()), String::new())
            } else {
                let quote = joined.quote();
                let (right, _) = right_side(&joined.carry, quote, line.quote, &opens, &text[at..]);
                (Some(format!("{}{closes}", &text[..at])), right)
            }
        };
        let ending = self.empty_line_ending(joined.first);
        let columns = usize::from(columns);
        let table_above =
            joined.first > 0 && matches!(self.line(joined.first - 1).line.kind, Kind::Table { .. });
        let mut out = String::new();
        if let Some(left) = &left {
            out.push_str(left);
            out.push_str(&ending);
        } else if table_above {
            out.push_str(&ending);
        }
        // After the header's first pipe and its first cell's first space.
        let caret = out.len() + 2;
        out.push_str(&new_row(EMPTY_CELL, columns));
        out.push_str(&ending);
        out.push_str(&new_row(DELIMITER_CELL, columns));
        for _ in 1..rows {
            out.push_str(&ending);
            out.push_str(&new_row(EMPTY_CELL, columns));
        }
        let next = joined.last + 1;
        let row_below = if right.is_empty() {
            next < self.line_count() && self.line(next).body().starts_with('|')
        } else {
            right.starts_with('|')
        };
        if !right.is_empty() {
            out.push_str(&ending);
        }
        if row_below {
            out.push_str(&ending);
        }
        out.push_str(&right);
        Some(self.rejoin(&joined, &out, caret))
    }
}

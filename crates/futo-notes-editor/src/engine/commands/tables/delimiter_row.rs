//! A table's delimiter row is not reachable. It stays in the source and on
//! its display line (hosts need not draw it), but a caret the user moves or
//! places never stands on it: from the display start of the row through its
//! text's end. The one exception is the person typing the row: typing on
//! its line leaves the caret there (`writes_delimiter_row`), and typing and
//! Backspace on it are ordinary, until the keystroke that finishes the row,
//! or Enter or Tab, takes the caret to the first body row (written when
//! there is none). A Backspace right after any of those takes it back. A caret a host's echo, a paste or Undo leaves on the row stays
//! until it moves.
use super::super::super::command::{Command, Edit};
use super::super::super::edit::Batch;
use super::super::super::history::{Group, Point};
use super::super::super::line::Entry;
use super::super::super::{store, Engine, RowExit};
use super::keys::append_row;
use crate::lines::{Kind, TableRole};
use crate::{CaretDirection, DisplayOffset, DisplayRange, EditorError, SourceEdit, ViewChange};

/// Whether line `entry` is a table's delimiter row.
pub(crate) fn is_delimiter_row(entry: &Entry) -> bool {
    matches!(
        entry.line.kind,
        Kind::Table {
            role: TableRole::Delimiter,
            ..
        }
    )
}

/// Where a caret goes instead of a delimiter row, in display offsets: the
/// header's text end, and the start of the line after the row when one
/// follows.
struct Edges {
    before: usize,
    after: Option<usize>,
}

impl Edges {
    /// The edge nearer `at` (after, on a tie).
    fn nearer(&self, at: usize) -> usize {
        match self.after {
            Some(after) if after - at <= at - self.before => after,
            _ => self.before,
        }
    }

    /// Where a caret placed at `at` goes: away from the side a caret `from`
    /// came from (from below, the header's end; from above, the line after
    /// the row), else the nearer edge.
    fn away_from(&self, from: DisplayRange, at: usize) -> usize {
        if from.start != from.end {
            return self.nearer(at);
        }
        if from.start.0 <= self.before {
            return self.after.unwrap_or(self.before);
        }
        if self.after.is_some_and(|after| from.start.0 >= after) {
            return self.before;
        }
        self.nearer(at)
    }
}

fn caret(at: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(at),
        end: DisplayOffset(at),
    }
}

impl Engine {
    /// The edges of the delimiter row display offset `at` stands on.
    fn delimiter_row_edges(&self, at: usize) -> Option<Edges> {
        let (index, before) = self.line_at_display(store::display, at);
        let entry = self.line(index);
        if !is_delimiter_row(entry) || at > before.display + entry.shown_len() {
            return None;
        }
        let header = self.line(index - 1);
        Some(Edges {
            before: before.display - header.ending().len(),
            after: (entry.view.ending && index + 1 < self.line_count())
                .then_some(before.display + entry.size.display),
        })
    }

    /// `range` off delimiter rows and out of rows' spelling, as the user
    /// places it: a caret on a delimiter row goes to the edge away from
    /// where the caret came from (a keyboard's cursor swipe up from the row
    /// below goes on to the header), or its nearer edge (after, on a tie)
    /// when the selection was on the row or a range; a caret inside another
    /// row's spelling goes to a cell (`cell_stop`). A range's end on a
    /// delimiter row moves off it toward the range's inside, so a range
    /// never takes part of the row, and one left with nothing between its
    /// ends is a caret where its start goes; a range's end on another row's
    /// spelling stays, as a selection across cells.
    pub(crate) fn placed_in_tables(&self, range: DisplayRange) -> DisplayRange {
        let start = self.delimiter_row_edges(range.start.0);
        if range.start == range.end {
            let from = self.selection;
            let at = range.start.0;
            return caret(start.map_or_else(
                || self.cell_stop(at, from),
                |edges| edges.away_from(from, at),
            ));
        }
        let from = start.map_or(range.start.0, |edges| edges.after.unwrap_or(edges.before));
        let to = self
            .delimiter_row_edges(range.end.0)
            .map_or(range.end.0, |edges| edges.before);
        if from >= to {
            return self.placed_in_tables(caret(range.start.0));
        }
        DisplayRange {
            start: DisplayOffset(from),
            end: DisplayOffset(to),
        }
    }

    /// Where a caret moving in `direction` that would stop at display offset
    /// `at` stops: past the delimiter row `at` stands on, else at `at`.
    pub(crate) fn past_delimiter_row(&self, at: usize, direction: CaretDirection) -> usize {
        let Some(edges) = self.delimiter_row_edges(at) else {
            return at;
        };
        match direction {
            CaretDirection::Forward => edges.after.unwrap_or(edges.before),
            CaretDirection::Backward => edges.before,
        }
    }

    /// Whether display offset `at` stands on a delimiter row.
    pub(crate) fn on_delimiter_row(&self, at: usize) -> bool {
        self.delimiter_row_edges(at).is_some()
    }

    /// Whether line `index` is a finished delimiter row: as many cells as its
    /// header, and a closing `|` where the header line ends with one. A
    /// header with no closing pipe has no finished row; Enter leaves it.
    pub(crate) fn is_finished_row(&self, index: usize) -> bool {
        let row = self.line(index);
        if !is_delimiter_row(row) {
            return false;
        }
        let header = self.line(index - 1);
        let closes = |body: &str| {
            let body = body.trim_end_matches([' ', '\t']);
            body.ends_with('|') && !body.ends_with("\\|")
        };
        closes(header.body())
            && closes(row.body())
            && crate::lines::table::cells(row.body()).len() == header.cells
    }

    /// Where the caret leaves the delimiter row on line `index` for: the
    /// start of the first body row's first cell. A blank first body row
    /// (`|`, then `  |` per column) is written when the table has none: the
    /// edit, and the caret's source offset after it.
    fn first_body_cell(&self, index: usize) -> Option<(Option<Edit>, usize)> {
        let table = self.table_at(index)?;
        if table.rows() > 1 {
            let row = table.row(1);
            let start = row
                .contents
                .first()
                .map_or(row.end, |content| content.start);
            return Some((None, start));
        }
        let mut command = append_row(&table, 0);
        Some((command.edits.pop(), command.selection.start))
    }

    /// The keystroke that finishes the delimiter row the caret is typing on
    /// line `index` (`is_finished_row`, which it was not before) leaves it:
    /// the first body row is written into `batch` when the table has none,
    /// and this answers the caret's source offset, at that row's first cell.
    pub(crate) fn finished_row_exit(&mut self, batch: &mut Batch, index: usize) -> Option<usize> {
        if !self.is_finished_row(index) {
            return None;
        }
        let (edit, caret) = self.first_body_cell(index)?;
        if let Some(edit) = edit {
            self.raw(batch, edit.range.clone(), &edit.text);
        }
        Some(caret)
    }

    /// Enter, Shift+Enter or Tab at a caret on a delimiter row leave it for
    /// the first body row's first cell, as the finishing keystroke does: the
    /// row is never split and no line goes between it and the header.
    pub(crate) fn delimiter_row_key(&self, range: DisplayRange) -> Option<Command> {
        if range.start != range.end || !self.on_delimiter_row(range.start.0) {
            return None;
        }
        let (index, _) = self.line_at_display(store::display, range.start.0);
        let (edit, caret) = self.first_body_cell(index)?;
        let named = index..index + 1;
        Some(Command::new(
            edit.into_iter().collect(),
            named,
            caret..caret,
        ))
    }

    /// The caret left the delimiter row it was writing (Enter or Tab on it,
    /// `delimiter_row_key`) from `before`; `wrote` when the move wrote the
    /// first body row, its own Undo step.
    pub(crate) fn left_row(&mut self, before: Point, wrote: bool) {
        self.typed_table = Some(RowExit {
            revision: self.revision,
            caret: self.selection,
            before,
            wrote,
        });
    }

    /// Backspace right after the keystroke that took the caret off a
    /// delimiter row being typed (`finished_row_exit`, `left_row`): that
    /// keystroke taken back, as an edit of its own when it wrote (its
    /// character and the body row it wrote), so the caret is back where it
    /// was, typing the row. `None` at any other time.
    pub(crate) fn untyped_table_start(
        &mut self,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let exit = match &self.typed_table {
            Some(exit)
                if exit.revision == self.revision
                    && exit.caret == self.selection
                    && self.composition.is_none() =>
            {
                exit.clone()
            }
            _ => return Ok(None),
        };
        self.typed_table = None;
        if !exit.wrote {
            self.restore(&exit.before);
            self.writing_row = Some((self.revision, self.selection));
            return Ok(Some(self.unchanged()));
        }
        let Some(group) = self.history.undo.last().cloned() else {
            return Ok(None);
        };
        let before = self.point();
        let mut batch = Batch::default();
        for record in group.records.iter().rev() {
            let range = record.start..record.start + record.inserted.len();
            self.raw(&mut batch, range, &record.removed);
        }
        let Some((edit, shown, records)) = self.accept(batch, accept)? else {
            return Ok(None);
        };
        self.restore(&exit.before);
        self.writing_row = Some((self.revision, self.selection));
        self.typing = None;
        self.history.redo.clear();
        self.history.undo.push(Group {
            records,
            before,
            after: self.point(),
        });
        let change = self.change(edit, shown);
        Ok(Some(self.view(change)))
    }
}

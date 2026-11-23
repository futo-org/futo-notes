//! A selection that covers every cell of a table takes the table whole, so
//! removing it leaves no pipe and no delimiter row behind. Every plan asks
//! `whole_tables` (`edit/plan.rs`), so Backspace, Delete, cut and typing over
//! the selection agree.
use super::super::super::table_block::TableBlock;
use super::super::super::Engine;
use super::{role, Row};
use crate::{DisplayOffset, DisplayRange};

impl Engine {
    /// Display `range` with each end that lies on the lines of a table it
    /// covers moved to that table's outer edge: the start to its header's
    /// start, the end to its last line's end (before its line ending). A
    /// range covers a table when it reaches from at or before the header's
    /// first cell's content to at or after the last row's last cell's
    /// content (the header's, in a header-only table; a last row with no cell is
    /// skipped for the nearest row above that has one). A range inside one
    /// cell is that cell's text, even in a one-cell table.
    pub(crate) fn whole_tables(&self, range: DisplayRange) -> DisplayRange {
        if range.start == range.end || self.column_at(range).is_some() {
            return range;
        }
        let source = self.source_selection(range);
        let mut whole = range;
        if let Some(table) = self.covered_table(self.line_of(source.start), range) {
            whole.start = DisplayOffset(self.display_of(self.line_start(table.header)));
        }
        if let Some(table) = self.covered_table(self.line_of(source.end), range) {
            let end = self.line_start(table.last) + self.line(table.last).body_len();
            whole.end = DisplayOffset(self.display_of(end));
        }
        whole
    }

    /// The table line `index` lies in, when display `range` covers it.
    fn covered_table(&self, index: usize, range: DisplayRange) -> Option<TableBlock> {
        role(self.line(index))?;
        let table = TableBlock::holding(&self.store, index);
        let last_row = if table.last == table.delimiter {
            table.header
        } else {
            table.last
        };
        let read = |index: usize| Row::read(self.line(index), index, self.line_start(index));
        let first = read(table.header).contents.first()?.start;
        // A last row with no cell (a lone `|`) has no content to reach: the range
        // reaches the last cell of the nearest row above that has one.
        let last = (table.header..=last_row)
            .rev()
            .filter(|&row| row != table.delimiter)
            .find_map(|row| read(row).contents.last().map(|cell| cell.end))?;
        let covers =
            range.start.0 <= self.display_of(first) && range.end.0 >= self.display_of(last);
        covers.then_some(table)
    }
}

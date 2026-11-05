//! The visible inline bodies a selection covers: a paragraph, heading text,
//! a list or task item body, a quote body and each root table cell. Code,
//! front matter, raw HTML, dividers, blank lines and table delimiter rows hold
//! none. An inline toggle never spans two of them.
use super::*;
use crate::inline::blocks::BlockLine;
use crate::TableDescription;

/// One body within the selection, trimmed of edge whitespace: whole, and
/// each of its physical lines.
pub(super) struct Body {
    pub range: DisplayRange,
    pub lines: Vec<DisplayRange>,
    /// A table cell: its toggle may never add or remove a cell pipe.
    pub cell: bool,
}

pub(super) struct Bodies {
    /// The selection touches more than one body.
    pub multi: bool,
    pub bodies: Vec<Body>,
}

/// Whether `line` continues the paragraph `previous` holds (a soft line
/// break), rather than starting a block of its own.
fn continues(previous: &BlockLine, line: &BlockLine) -> bool {
    previous.paragraph_text
        && line.paragraph_text
        && previous.heading == 0
        && line.heading == 0
        && previous.quote_depth == line.quote_depth
        && previous.source.end == line.source.start
        && line.list.as_ref().is_none_or(|list| !list.first)
}

fn span(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

impl EditorSession {
    pub(super) fn format_bodies(&self, range: DisplayRange) -> Bodies {
        let (from, to) = (range.start.0, range.end.0);
        let lines = self.projection.format_block_lines(range);
        // Untrimmed selected line ranges per body, and whether it is a cell.
        let mut groups: Vec<(Vec<(usize, usize)>, bool)> = Vec::new();
        let mut previous: Option<&BlockLine> = None;
        let mut table: Option<TableDescription> = None;
        for line in &lines {
            let start = self.projection.display_at(line.content.start);
            let end = self.projection.display_at(line.content.end);
            let (a, z) = (start.max(from), end.min(to));
            if line.code
                || line.metadata
                || line.html
                || line.divider
                || line.empty_comment
                || a >= z
            {
                previous = None;
                continue;
            }
            if let Some(cells) = self.table_cells(line, start, end, &mut table) {
                for cell in cells {
                    let (a, z) = (cell.start.0.max(from), cell.end.0.min(to));
                    if a < z {
                        groups.push((vec![(a, z)], true));
                    }
                }
                previous = None;
                continue;
            }
            match (previous, groups.last_mut()) {
                (Some(previous), Some((group, false))) if continues(previous, line) => {
                    group.push((a, z));
                }
                _ => groups.push((vec![(a, z)], false)),
            }
            previous = Some(line);
        }
        let multi = groups.len() > 1;
        let bodies = groups
            .into_iter()
            .filter_map(|(group, cell)| {
                let lines: Vec<_> = group
                    .into_iter()
                    .filter_map(|(a, z)| self.trimmed(a, z))
                    .collect();
                Some(Body {
                    range: span(lines.first()?.start.0, lines.last()?.end.0),
                    lines,
                    cell,
                })
            })
            .collect();
        Bodies { multi, bodies }
    }

    /// `a..z` without its edge whitespace; `None` when nothing is left.
    fn trimmed(&self, a: usize, z: usize) -> Option<DisplayRange> {
        let text = self.projection.display.byte_slice(a..z).to_string();
        let body = text.trim_start();
        let start = a + text.len() - body.len();
        let end = start + body.trim_end().len();
        (start < end).then(|| span(start, end))
    }

    /// The cell contents of a root table row `line` (display `start..end`),
    /// or `None` when it is not a table line. A delimiter row has no cells.
    /// One table answers each of its following rows.
    fn table_cells(
        &self,
        line: &BlockLine,
        start: usize,
        end: usize,
        table: &mut Option<TableDescription>,
    ) -> Option<Vec<DisplayRange>> {
        if !line.paragraph_text
            || line.heading != 0
            || line.quote_depth != 0
            || line.list.is_some()
            || line.in_list
        {
            return None;
        }
        let within =
            |table: &TableDescription| table.display.start.0 <= start && end <= table.display.end.0;
        if !table.as_ref().is_some_and(within) {
            if !self
                .projection
                .display
                .byte_slice(start..end)
                .chars()
                .any(|ch| ch == '|')
            {
                return None;
            }
            *table = self.inspect_table(self.revision, span(start, start)).ok()?;
        }
        let found = table.as_ref().filter(|table| within(table))?;
        if found
            .delimiter_line
            .is_some_and(|line| line.start.0 <= start && start <= line.end.0)
        {
            return Some(Vec::new());
        }
        let row = found
            .row_lines
            .iter()
            .position(|line| line.start.0 <= start && start <= line.end.0)?;
        Some(found.rows[row].iter().map(|cell| cell.content).collect())
    }
}

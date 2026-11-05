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

/// One format line's offsets and reading, independent of its neighbours.
struct Placed {
    start: usize,
    end: usize,
    /// Holds no inline body within the selection.
    skip: bool,
    trimmed: Option<DisplayRange>,
    /// A root paragraph line with a pipe: it may be a table row.
    pipe: bool,
}

/// Only root paragraph text can be a table row.
fn table_candidate(line: &BlockLine) -> bool {
    line.paragraph_text
        && line.heading == 0
        && line.quote_depth == 0
        && line.list.is_none()
        && !line.in_list
}

/// `a..z` without its edge whitespace; `None` when nothing is left.
fn trimmed(projection: &crate::inline::Projection, a: usize, z: usize) -> Option<DisplayRange> {
    let text = projection.display.byte_slice(a..z).to_string();
    let body = text.trim_start();
    let start = a + text.len() - body.len();
    let end = start + body.trim_end().len();
    (start < end).then(|| span(start, end))
}

fn span(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

impl EditorSession {
    pub(super) fn format_bodies(&self, range: DisplayRange) -> Bodies {
        self.bodies_in(range, &self.projection.format_block_lines(range))
    }

    /// [`Self::format_bodies`] over `range`'s already-read format lines.
    pub(super) fn bodies_in(&self, range: DisplayRange, lines: &[BlockLine]) -> Bodies {
        let (from, to) = (range.start.0, range.end.0);
        // Each line's own offsets, trimmed text and table hint, read in
        // parallel; grouping them into bodies stays in order below.
        let projection = &self.projection;
        let placed = crate::parallel::map(lines, |line| {
            let start = projection.display_at(line.content.start);
            let end = projection.display_at(line.content.end);
            let (a, z) = (start.max(from), end.min(to));
            let skip = line.code
                || line.metadata
                || line.html
                || line.divider
                || line.empty_comment
                || a >= z;
            Placed {
                start,
                end,
                skip,
                trimmed: if skip {
                    None
                } else {
                    trimmed(projection, a, z)
                },
                pipe: !skip
                    && table_candidate(line)
                    && projection
                        .display
                        .byte_slice(start..end)
                        .chars()
                        .any(|ch| ch == '|'),
            }
        });
        // Trimmed selected line ranges per body, and whether it is a cell.
        let mut groups: Vec<(Vec<Option<DisplayRange>>, bool)> = Vec::new();
        let mut previous: Option<&BlockLine> = None;
        let mut table: Option<TableDescription> = None;
        for (line, placed) in lines.iter().zip(placed) {
            if placed.skip {
                previous = None;
                continue;
            }
            if let Some(cells) =
                self.table_cells(line, placed.start, placed.end, placed.pipe, &mut table)
            {
                for cell in cells {
                    let (a, z) = (cell.start.0.max(from), cell.end.0.min(to));
                    if a < z {
                        groups.push((vec![trimmed(projection, a, z)], true));
                    }
                }
                previous = None;
                continue;
            }
            match (previous, groups.last_mut()) {
                (Some(previous), Some((group, false))) if continues(previous, line) => {
                    group.push(placed.trimmed);
                }
                _ => groups.push((vec![placed.trimmed], false)),
            }
            previous = Some(line);
        }
        let multi = groups.len() > 1;
        let bodies = groups
            .into_iter()
            .filter_map(|(group, cell)| {
                let lines: Vec<_> = group.into_iter().flatten().collect();
                Some(Body {
                    range: span(lines.first()?.start.0, lines.last()?.end.0),
                    lines,
                    cell,
                })
            })
            .collect();
        Bodies { multi, bodies }
    }

    /// The cell contents of a root table row `line` (display `start..end`),
    /// or `None` when it is not a table line. A delimiter row has no cells.
    /// One table answers each of its following rows.
    fn table_cells(
        &self,
        line: &BlockLine,
        start: usize,
        end: usize,
        pipe: bool,
        table: &mut Option<TableDescription>,
    ) -> Option<Vec<DisplayRange>> {
        if !table_candidate(line) {
            return None;
        }
        let within =
            |table: &TableDescription| table.display.start.0 <= start && end <= table.display.end.0;
        if !table.as_ref().is_some_and(within) {
            if !pipe {
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

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
    /// The selection is not inside one cell of a table it touches (it runs
    /// over a pipe, a delimiter row or a row boundary): the raw selection
    /// must not be toggled as one run, whatever the body count.
    pub straddles: bool,
    pub bodies: Vec<Body>,
}

impl Bodies {
    /// Toggle each body rather than the selection as one run.
    pub fn per_body(&self) -> bool {
        self.multi || self.straddles
    }
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

/// Pipeless lines in a row after which the walk for a table header stops.
const PIPELESS_ROWS: usize = 256;

impl EditorSession {
    pub(super) fn format_bodies(&self, range: DisplayRange) -> Bodies {
        self.bodies_in(range, &self.projection.format_block_lines(range))
    }

    /// Where a table holding the line at `at` may begin: the start of the
    /// nonblank run above it when a line of that run has a pipe (every
    /// table's header does), else the line itself. The walk gives up after
    /// `PIPELESS_ROWS` lines in a row without a pipe (a table whose pipeless
    /// rows run longer is read from the selection only), so prose costs a
    /// bounded scan, with no allocation and no table reading.
    fn run_start(&self, at: usize) -> usize {
        let display = &self.projection.display;
        let own = display.byte_to_line(at);
        let (mut line, mut piped, mut streak) = (own, false, 0);
        while line > 0 && streak < PIPELESS_ROWS {
            let above = display.line(line - 1);
            if above.chars().all(char::is_whitespace) {
                break;
            }
            if above.chars().any(|ch| ch == '|') {
                piped = true;
                streak = 0;
            } else {
                streak += 1;
            }
            line -= 1;
        }
        display.line_to_byte(if piped { line } else { own })
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
            let skip = line.code || line.metadata || line.html || line.divider || a >= z;
            Placed {
                start,
                end,
                skip,
                trimmed: if skip {
                    None
                } else {
                    trimmed(projection, a, z)
                },
            }
        });
        // Trimmed selected line ranges per body, and whether it is a cell.
        let mut groups: Vec<(Vec<Option<DisplayRange>>, bool)> = Vec::new();
        let mut previous: Option<&BlockLine> = None;
        let mut straddles = false;
        // Every root table the range touches: a line inside one is a table
        // line whatever the block walk reads it as (a delimiter row starting
        // `- ` is a list item there, a row without outer pipes a paragraph).
        // The range may start mid-table, where the block walk sees only list
        // or paragraph lines: read from the start of the nonblank run.
        let tables = self
            .inspect_tables(self.revision, span(self.run_start(from), to))
            .unwrap_or_default();
        for (line, placed) in lines.iter().zip(placed) {
            if placed.skip {
                previous = None;
                continue;
            }
            if let Some(cells) = table_cells(&tables, placed.start, placed.end) {
                let (a, z) = (placed.start.max(from), placed.end.min(to));
                straddles |= !cells
                    .iter()
                    .any(|cell| cell.start.0 <= a && z <= cell.end.0);
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
        Bodies {
            multi,
            straddles,
            bodies,
        }
    }
}

/// The cell contents of the table row at display `start..end`, or `None`
/// when it is in no table. A delimiter row has no cells.
fn table_cells(tables: &[TableDescription], start: usize, end: usize) -> Option<Vec<DisplayRange>> {
    let table = tables
        .iter()
        .find(|table| table.display.start.0 <= start && end <= table.display.end.0)?;
    let at = |line: &DisplayRange| line.start.0 <= start && start <= line.end.0;
    if table.delimiter_line.as_ref().is_some_and(at) {
        return Some(Vec::new());
    }
    let row = table.row_lines.iter().position(at)?;
    Some(table.rows[row].iter().map(|cell| cell.content).collect())
}

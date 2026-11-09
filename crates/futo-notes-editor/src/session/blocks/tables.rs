//! GFM table cells as editing units. Cells project onto the note's own display
//! coordinates, so one selection serves both views; every edit is one source
//! replacement through the shared block-edit path (history, recovery, links).
use super::*;
use crate::table::{self, Layout, Splice};
use crate::{
    TableCell, TableCommand, TableControls, TableDescription, TableFocus, TableKey, TableOutcome,
};
use std::ops::Range;

mod input;
mod keys;
#[cfg(test)]
mod differential;

struct Window {
    base: usize,
    text: String,
    layout: Layout,
}

impl Window {
    fn absolute(&self, range: Range<usize>) -> Range<usize> {
        self.base + range.start..self.base + range.end
    }

    fn cell_content(&self, row: usize, column: usize) -> Option<Range<usize>> {
        let raw = self.layout.row_line(row).cells.get(column)?;
        Some(self.absolute(Layout::content(&self.text, raw)))
    }
}

/// A nonblank run with every table in it, for scans that visit many of its
/// lines.
struct Run {
    base: usize,
    text: String,
    layouts: Vec<Layout>,
}

impl Run {
    /// Whether source offset `at` lies on a line of the run.
    fn holds(&self, at: usize) -> bool {
        self.base <= at && at < self.base + self.text.len()
    }

    /// The table holding the line at run offset `at`.
    fn table_at(&self, at: usize) -> Option<&Layout> {
        let index = self
            .layouts
            .partition_point(|layout| layout.lines.last().unwrap().next <= at);
        let layout = self.layouts.get(index)?;
        (layout.lines[0].start <= at).then_some(layout)
    }
}

impl EditorSession {
    fn table_line_start(&self, at: usize) -> usize {
        let mut bytes = self.source.bytes_at(at);
        let mut at = at;
        while at > 0 {
            if bytes.prev() == Some(b'\n') {
                return at;
            }
            at -= 1;
        }
        0
    }

    /// Content end and next-line start of the physical line beginning at `at`.
    fn table_line_end(&self, at: usize) -> (usize, usize) {
        let mut index = at;
        let mut last = 0;
        for byte in self.source.bytes_at(at) {
            if byte == b'\n' {
                let end = if last == b'\r' && index > at {
                    index - 1
                } else {
                    index
                };
                return (end, index + 1);
            }
            last = byte;
            index += 1;
        }
        (index, index)
    }

    fn table_line_blank(&self, start: usize, end: usize) -> bool {
        self.source
            .bytes_at(start)
            .take(end - start)
            .all(|byte| matches!(byte, b' ' | b'\t' | b'\r'))
    }

    /// The run of nonblank lines around `at` (start, text); a table lives
    /// inside one run.
    fn table_run(&self, at: usize) -> Option<(usize, String)> {
        let length = self.source.len_bytes();
        let line = self.table_line_start(at.min(length));
        let (end, next) = self.table_line_end(line);
        if self.table_line_blank(line, end) {
            return None;
        }
        let mut start = line;
        while start > 0 {
            let previous = self.table_line_start(start - 1);
            if self.table_line_blank(previous, start - 1) {
                break;
            }
            start = previous;
        }
        let mut stop = next;
        while stop < length {
            let (end, next) = self.table_line_end(stop);
            if self.table_line_blank(stop, end) {
                break;
            }
            stop = next;
        }
        Some((start, self.source.byte_slice(start..stop).to_string()))
    }

    /// Whether a table headed at source offset `header` sits at the root:
    /// not in code, a quote, a list or a heading.
    fn table_at_root(&self, header: usize) -> bool {
        let display = DisplayOffset(self.projection.display_at(header));
        self.projection
            .block_lines(DisplayRange {
                start: display,
                end: display,
            })
            .iter()
            .all(|line| {
                !line.code
                    && line.quote_depth == 0
                    && line.list.is_none()
                    && !line.in_list
                    && line.heading == 0
                    && !line.divider
            })
    }

    /// Whether a table can hold source offset `at`: its header line holds a
    /// `|`, so some row from `at` back to the start of its nonblank run does.
    /// `visits`: rows checked. `barren`: an earlier offset of the same scan
    /// whose walk found no `|` back to its run's start, so reaching a row at
    /// or before it ends this walk too.
    fn table_possible(&self, at: usize, barren: Option<usize>, visits: &mut usize) -> bool {
        let rows = &self.projection.rows;
        let mut index = rows.locate(at, false);
        loop {
            *visits += 1;
            let (row, start, _) = rows.at(index);
            if row.pipes {
                return true;
            }
            if barren.is_some_and(|barren| barren <= at && start <= barren) {
                return false;
            }
            // A row starting at a word seam continues its predecessor's
            // line, which holds no `|` (word seams never cut such a line):
            // go on from the row where that line starts.
            if row.mid_line {
                let line = self.source.line_to_byte(self.source.byte_to_line(start));
                index = rows.locate(line, false);
                continue;
            }
            // A blank line before the row ends the run.
            let mut before = self.source.bytes_at(start);
            if index == 0 || before.prev() != Some(b'\n') {
                return false;
            }
            loop {
                match before.prev() {
                    Some(b' ' | b'\t' | b'\r') => {}
                    Some(b'\n') | None => return false,
                    Some(_) => break,
                }
            }
            index -= 1;
        }
    }

    /// `read`: source bytes of the nonblank run read, and rows checked.
    fn table_window(&self, at: usize, read: &mut usize) -> Option<Window> {
        // A list, quote, code or heading line is never a root table's row,
        // and a run without a `|` near enough holds no table: answer from
        // the projection before reading the run.
        if !self.table_at_root(at) || !self.table_possible(at, None, read) {
            return None;
        }
        let (base, text) = self.table_run(at)?;
        *read += text.len();
        let layout = Layout::find(&text, at - base)?;
        self.table_at_root(base + layout.lines[0].start)
            .then_some(Window { base, text, layout })
    }

    /// Source span a display selection stands for, one offset for a caret.
    fn table_source_span(&self, range: DisplayRange) -> (usize, usize) {
        let (low, _) = self.projection.source_bounds(range.start.0);
        let (_, high) = self.projection.source_bounds(range.end.0);
        if range.start == range.end {
            let (low, high) = self.projection.source_bounds(range.start.0);
            let at = if self.affinity == Affinity::Backward {
                low
            } else {
                high
            };
            (at, at)
        } else {
            (low, high)
        }
    }

    /// The table and cell at `range` for paths that need a cell: a range
    /// outside every cell of its own line (past a row's closing pipe, say)
    /// answers from that line alone instead of reading the whole table.
    fn table_cell_target_counted(
        &self,
        range: DisplayRange,
        read: &mut usize,
    ) -> Option<(Window, (usize, usize))> {
        let (start, end) = self.table_source_span(range);
        let line = self.table_line_start(start);
        let (line_end, _) = self.table_line_end(line);
        if end > line_end {
            return None;
        }
        let text = self.source.byte_slice(line..line_end).to_string();
        *read += text.len();
        if !table::line_has_cell(&text, start - line..end - line) {
            return None;
        }
        let (window, cell) = self.table_target_counted(range, read)?;
        Some((window, cell?))
    }

    pub(super) fn in_table(&self, range: DisplayRange) -> bool {
        self.table_target(range).is_some()
    }

    pub(super) fn in_table_cell(&self, range: DisplayRange) -> bool {
        self.table_target(range)
            .is_some_and(|(_, cell)| cell.is_some())
    }

    fn table_target(&self, range: DisplayRange) -> Option<(Window, Option<(usize, usize)>)> {
        self.table_target_counted(range, &mut 0)
    }

    fn table_target_counted(
        &self,
        range: DisplayRange,
        read: &mut usize,
    ) -> Option<(Window, Option<(usize, usize)>)> {
        let (start, end) = self.table_source_span(range);
        let window = self.table_window(start, read)?;
        let cell = window
            .layout
            .locate(start - window.base..end.saturating_sub(window.base));
        Some((window, cell))
    }

    /// Display ranges outside every table cell's content (pipes, padding,
    /// delimiter rows, row breaks): no find match may touch or span them. One
    /// pass over the source for an explicit scan, never the input path: each
    /// nonblank run is read once and yields all of its tables.
    pub(crate) fn table_find_barriers(&self, bytes: &std::cell::Cell<u64>) -> Vec<DisplayRange> {
        let length = self.source.len_bytes();
        let mut barriers = Vec::new();
        let mut at = 0;
        while at < length {
            let Some((base, text)) = self.table_run(at) else {
                at = self.table_line_end(at).1.max(at + 1);
                continue;
            };
            bytes.set(bytes.get() + text.len() as u64);
            for layout in Layout::all(&text) {
                if !self.table_at_root(base + layout.lines[0].start) {
                    continue;
                }
                let mut previous = self.projection.display_at(base + layout.lines[0].start);
                for row in 0..layout.rows() {
                    for raw in layout.row_line(row).cells.iter().take(layout.columns) {
                        let content = Layout::content(&text, raw);
                        let cell = self.display_range(base + content.start..base + content.end);
                        if previous < cell.start.0 {
                            barriers.push(DisplayRange {
                                start: DisplayOffset(previous),
                                end: cell.start,
                            });
                        }
                        previous = cell.end.0;
                    }
                }
                let end = self
                    .projection
                    .display_at(base + layout.lines.last().unwrap().end);
                if previous < end {
                    barriers.push(DisplayRange {
                        start: DisplayOffset(previous),
                        end: DisplayOffset(end),
                    });
                }
            }
            at = base + text.len();
        }
        barriers
    }

    fn display_range(&self, source: Range<usize>) -> DisplayRange {
        DisplayRange {
            start: DisplayOffset(self.projection.display_at(source.start)),
            end: DisplayOffset(self.projection.display_at(source.end)),
        }
    }

    /// Every table a root line in `range` lies in, in order: what a host gets
    /// by asking `inspect_table` at each block start, in one call. Each
    /// nonblank run is read once however many of its lines the range holds.
    pub fn inspect_tables(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Vec<TableDescription>, EditorError> {
        self.check_revision(expected)?;
        self.validate_range(range)?;
        let mut tables: Vec<TableDescription> = Vec::new();
        let mut covered = 0;
        let mut run: Option<Run> = None;
        let mut barren = None;
        for line in self.projection.view_block_lines(range) {
            // A list, quote, code or heading line is never a root table row.
            // This filter is the whole root check: `table_at_root` per line
            // reads the entire row, quadratic in a heading-dense note.
            if line.code
                || line.quote_depth > 0
                || line.list.is_some()
                || line.in_list
                || line.heading > 0
                || line.divider
            {
                continue;
            }
            let at = self.projection.display_at(line.content.start);
            if at < covered {
                continue;
            }
            let (start, end) = self.table_source_span(DisplayRange {
                start: DisplayOffset(at),
                end: DisplayOffset(at),
            });
            if !run.as_ref().is_some_and(|run| run.holds(start)) {
                run = None;
                if !self.table_possible(start, barren, &mut 0) {
                    barren = Some(start);
                    continue;
                }
                let Some((base, text)) = self.table_run(start) else {
                    continue;
                };
                let layouts = Layout::all(&text);
                run = Some(Run {
                    base,
                    text,
                    layouts,
                });
            }
            let run = run.as_ref().unwrap();
            let Some(layout) = run.table_at(start - run.base) else {
                continue;
            };
            if !self.table_at_root(run.base + layout.lines[0].start) {
                continue;
            }
            let focus = layout.locate(start - run.base..end.saturating_sub(run.base));
            let table = self.describe_table(run.base, &run.text, layout, focus);
            covered = table.display.end.0;
            tables.push(table);
        }
        Ok(tables)
    }

    /// The table at `range`, with its focused cell and applicable commands when
    /// the range lies inside one cell. Hosts pass the current selection.
    pub fn inspect_table(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Option<TableDescription>, EditorError> {
        self.check_revision(expected)?;
        self.validate_range(range)?;
        let Some((window, focus)) = self.table_target(range) else {
            return Ok(None);
        };
        Ok(Some(self.describe_table(
            window.base,
            &window.text,
            &window.layout,
            focus,
        )))
    }

    fn describe_table(
        &self,
        base: usize,
        text: &str,
        layout: &Layout,
        focus: Option<(usize, usize)>,
    ) -> TableDescription {
        let rows = (0..layout.rows())
            .map(|row| {
                let line = layout.row_line(row);
                (0..line.cells.len().min(layout.columns))
                    .map(|column| {
                        let content = Layout::content(text, &line.cells[column]);
                        let source = base + content.start..base + content.end;
                        TableCell {
                            row,
                            column,
                            content: self.display_range(source.clone()),
                            source: SourceRange {
                                start: SourceOffset(source.start),
                                end: SourceOffset(source.end),
                            },
                        }
                    })
                    .collect()
            })
            .collect();
        let line_range =
            |line: &table::Line| self.display_range(base + line.start..base + line.end);
        let row_lines = (0..layout.rows())
            .map(|row| line_range(layout.row_line(row)))
            .collect();
        let delimiter_line = Some(line_range(&layout.lines[1]));
        let first = base + layout.lines[0].start;
        let last = base + layout.lines.last().unwrap().end;
        TableDescription {
            source: SourceRange {
                start: SourceOffset(first),
                end: SourceOffset(last),
            },
            display: self.display_range(first..last),
            columns: layout.columns,
            alignments: layout.alignments.clone(),
            rows,
            focus: focus.map(|(row, column)| TableFocus { row, column }),
            controls: focus.map(|(row, _)| -> TableControls { layout.controls(row) }),
            row_lines,
            delimiter_line,
        }
    }

    /// The cell an input edit lies in, when its text could change the grid
    /// (`|`, `\`, a line break); ordinary typing never reads the table.
    pub(in crate::session) fn input_cell(
        &self,
        range: DisplayRange,
        inserted: &str,
        work: &mut crate::inline::references::ReferenceWork,
    ) -> Option<CellInput> {
        if !inserted.contains(['|', '\\', '\r', '\n']) {
            return None;
        }
        let (window, (row, column)) = self.table_cell_target_counted(range, &mut work.parsed)?;
        let raw = window.absolute(window.layout.row_line(row).cells[column].clone());
        let pipes = table::pipe_count(&window.text);
        Some(CellInput {
            base: window.base,
            text: window.text,
            raw,
            pipes,
        })
    }

    /// Paste inside one cell: `flatten_for_cell` text through the ordinary
    /// input path. `None`: not in a table; across cells is refused.
    pub(super) fn paste_in_cell(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let Some((_, cell)) = self.table_target(range) else {
            return Ok(None);
        };
        cell.ok_or(EditorError::InvalidRange)?;
        let text = &table::flatten_for_cell(text);
        self.replace_markdown_action(expected, range, text, accept)
            .map(Some)
    }
}

/// Input inside one cell: `|` is written `\|` and line breaks become spaces;
/// an edit that leaves the cell or changes the pipe count is refused.
pub(in crate::session) struct CellInput {
    base: usize,
    text: String,
    raw: Range<usize>,
    pipes: usize,
}

impl CellInput {
    pub(in crate::session) fn flatten(inserted: &str) -> std::borrow::Cow<'_, str> {
        if inserted.contains(['\r', '\n']) {
            flatten_breaks(inserted).into()
        } else {
            inserted.into()
        }
    }

    pub(in crate::session) fn check(&self, edit: &SourceEdit) -> Result<(), EditorError> {
        let (start, end) = (edit.range.start.0, edit.range.end.0);
        if start < self.raw.start || self.raw.end < end {
            return Err(EditorError::UnrepresentableFormat);
        }
        let mut after = self.text.clone();
        after.replace_range(start - self.base..end - self.base, &edit.inserted);
        if table::pipe_count(&after) != self.pipes {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(())
    }
}

fn flatten_breaks(text: &str) -> String {
    text.replace("\r\n", " ").replace(['\r', '\n'], " ")
}

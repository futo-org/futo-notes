//! GFM table cells as editing units. Cells project onto the note's own display
//! coordinates, so one selection serves both views; every edit is one source
//! replacement through the shared block-edit path (history, recovery, links).
use super::*;
use crate::table::{self, Layout, Splice};
use crate::{
    TableCell, TableCommand, TableControls, TableDescription, TableFocus, TableKey, TableOutcome,
};
use std::ops::Range;

mod keys;

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

    /// The run of nonblank lines around `at`; a table lives inside one run.
    fn table_window(&self, at: usize) -> Option<Window> {
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
        let text = self.source.byte_slice(start..stop).to_string();
        let layout = Layout::find(&text, at - start)?;
        let header = start + layout.lines[0].start;
        let display = DisplayOffset(self.projection.display_at(header));
        let root = self
            .projection
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
            });
        root.then_some(Window {
            base: start,
            text,
            layout,
        })
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

    fn table_target(&self, range: DisplayRange) -> Option<(Window, Option<(usize, usize)>)> {
        let (start, end) = self.table_source_span(range);
        let window = self.table_window(start)?;
        let cell = window
            .layout
            .locate(start - window.base..end.saturating_sub(window.base));
        Some((window, cell))
    }

    /// Display ranges outside every table cell's content (pipes, padding,
    /// delimiter rows, row breaks): no find match may touch or span them. One
    /// pass over the source for an explicit scan, never the input path.
    pub(crate) fn table_find_barriers(&self) -> Vec<DisplayRange> {
        let source = self
            .source
            .byte_slice(0..self.source.len_bytes())
            .to_string();
        let mut barriers = Vec::new();
        let mut at = 0;
        while at < source.len() {
            let next = source[at..].find('\n').map_or(source.len(), |n| at + n + 1);
            let window = source[at..next]
                .contains('|')
                .then(|| self.table_window(at))
                .flatten();
            let Some(window) = window else {
                at = next;
                continue;
            };
            let layout = &window.layout;
            let first = window.base + layout.lines[0].start;
            let last = layout.lines.last().unwrap();
            let mut previous = self.projection.display_at(first);
            for row in 0..layout.rows() {
                for column in 0..layout.row_line(row).cells.len().min(layout.columns) {
                    let cell = self.display_range(window.cell_content(row, column).unwrap());
                    if previous < cell.start.0 {
                        barriers.push(DisplayRange {
                            start: DisplayOffset(previous),
                            end: cell.start,
                        });
                    }
                    previous = cell.end.0;
                }
            }
            let end = self.projection.display_at(window.base + last.end);
            if previous < end {
                barriers.push(DisplayRange {
                    start: DisplayOffset(previous),
                    end: DisplayOffset(end),
                });
            }
            at = (window.base + last.next).max(next);
        }
        barriers
    }

    fn display_range(&self, source: Range<usize>) -> DisplayRange {
        DisplayRange {
            start: DisplayOffset(self.projection.display_at(source.start)),
            end: DisplayOffset(self.projection.display_at(source.end)),
        }
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
        let layout = &window.layout;
        let rows = (0..layout.rows())
            .map(|row| {
                let line = layout.row_line(row);
                (0..line.cells.len().min(layout.columns))
                    .map(|column| {
                        let source = window.cell_content(row, column).unwrap();
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
        let first = window.base + layout.lines[0].start;
        let last = window.base + layout.lines.last().unwrap().end;
        Ok(Some(TableDescription {
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
        }))
    }

    /// Replace display text inside one cell. `|` is written `\|` and line
    /// breaks become spaces, so no other cell can change. `None`: the range is
    /// not in a table. A range crossing cells or touching pipes is refused.
    pub fn replace_in_cell(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let flat = flatten_breaks(inserted);
        self.cell_replace(expected, range, &flat, crate::InputAction::Typing, accept)
    }

    /// Plain-text paste at a cell selection, for the clipboard entry to route
    /// to. Edge blank lines go, inner line breaks become one space, edge
    /// spaces and tabs stay. One history action. `None`: not in a table.
    pub fn paste_into_table_cell(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let flat = table::flatten_for_cell(text);
        self.cell_replace(expected, range, &flat, crate::InputAction::Isolated, accept)
    }

    fn cell_replace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        action: crate::InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        self.validate_range(range)?;
        let Some((window, cell)) = self.table_target(range) else {
            return Ok(None);
        };
        let (row, column) = cell.ok_or(EditorError::InvalidRange)?;
        let raw = window.absolute(window.layout.row_line(row).cells[column].clone());
        let before = table::pipe_count(&window.text);
        let mut refused = false;
        self.escape_pipes = true;
        let result = self.replace_action(expected, range, text, action, &mut |edit| {
            let rel = edit.range.start.0.wrapping_sub(window.base)
                ..edit.range.end.0.wrapping_sub(window.base);
            let mut after = window.text.clone();
            let inside = raw.start <= edit.range.start.0 && edit.range.end.0 <= raw.end;
            if inside {
                after.replace_range(rel, &edit.inserted);
            }
            if !inside || table::pipe_count(&after) != before {
                refused = true;
                return Err("table cell edit would change the grid".into());
            }
            accept(edit)
        });
        self.escape_pipes = false;
        match result {
            Err(EditorError::Persistence(_)) if refused => Err(EditorError::UnrepresentableFormat),
            other => other.map(Some),
        }
    }
}

fn flatten_breaks(text: &str) -> String {
    text.replace("\r\n", " ").replace(['\r', '\n'], " ")
}

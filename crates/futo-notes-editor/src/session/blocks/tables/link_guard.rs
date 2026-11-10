//! What a link command may do to the tables it touches: find them, and check
//! the result before it is accepted.
use super::*;
use crate::table::Layout;
use crate::TableDescription;

impl EditorSession {
    /// Source bounds of the nonblank runs holding offsets `a..=b`.
    fn run_bounds(&self, a: usize, b: usize) -> (usize, usize) {
        let start = self
            .table_run(a)
            .map_or_else(|| self.table_line_start(a), |(base, _)| base);
        let stop = self.table_run(b).map_or_else(
            || self.table_line_end(b).1,
            |(base, text)| base + text.len(),
        );
        (start, stop)
    }

    /// The tables `range` touches, read from the start of its nonblank run so a
    /// range holding only list-like lines of a table (a `- ` delimiter row)
    /// still finds the table its header opens.
    pub(in crate::session) fn tables_touching(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Vec<TableDescription>, EditorError> {
        self.check_revision(expected)?;
        self.validate_range(range)?;
        let (a, b) = self.table_source_span(range);
        let (start, stop) = self.run_bounds(a, b);
        let mut tables = self.inspect_tables(expected, self.display_range(start..stop))?;
        tables.retain(|table| {
            table.display.start.0 <= range.end.0 && range.start.0 <= table.display.end.0
        });
        Ok(tables)
    }

    /// Whether `edit` leaves every table in the nonblank runs it touches as
    /// the engine reads it from the result: the same tables, rows and cells
    /// per row, and every cell the edit does not reach with its exact source.
    /// Both readings are fresh sessions over those runs, never a splice check.
    pub(in crate::session) fn edit_keeps_tables(&self, edit: &SourceEdit) -> bool {
        let (a, b) = (edit.range.start.0, edit.range.end.0);
        let (start, stop) = self.run_bounds(a, b);
        let old = self.source.byte_slice(start..stop).to_string();
        let (a, b) = (a - start, b - start);
        let new = format!("{}{}{}", &old[..a], edit.inserted, &old[b..]);
        // The raw GFM split (a renderer's reading) and the engine's own.
        let (before, after) = (run_layouts(&old), run_layouts(&new));
        let raw = before.len() == after.len()
            && before.iter().zip(&after).all(|((at, x), (to, y))| {
                x.columns == y.columns
                    && x.lines.len() == y.lines.len()
                    && x.lines.iter().zip(&y.lines).all(|(x, y)| {
                        x.cells.len() == y.cells.len()
                            && x.cells.iter().zip(&y.cells).all(|(x, y)| {
                                let (x, y) = (at + x.start..at + x.end, to + y.start..to + y.end);
                                (x.start <= b && a <= x.end) || old[x] == new[y]
                            })
                    })
            });
        let (before, after) = (read_tables(&old), read_tables(&new));
        raw && before.len() == after.len()
            && before.iter().zip(&after).all(|(x, y)| {
                x.rows.len() == y.rows.len()
                    && x.rows.iter().zip(&y.rows).all(|(x, y)| {
                        x.len() == y.len()
                            && x.iter().zip(y).all(|(x, y)| {
                                let (x, y) = (x.source, y.source);
                                // The edit reaches a cell through its padding too.
                                let pad = |at: usize, back: bool| {
                                    let space = |byte: &u8| matches!(byte, b' ' | b'\t');
                                    let bytes = old.as_bytes();
                                    if back {
                                        at - bytes[..at]
                                            .iter()
                                            .rev()
                                            .take_while(|b| space(b))
                                            .count()
                                    } else {
                                        at + bytes[at..].iter().take_while(|b| space(b)).count()
                                    }
                                };
                                (pad(x.start.0, true) <= b && a <= pad(x.end.0, false))
                                    || old[x.start.0..x.end.0] == new[y.start.0..y.end.0]
                            })
                    })
            })
    }
}

/// The tables a fresh session finds in `text`.
fn read_tables(text: &str) -> Vec<TableDescription> {
    let session = EditorSession::open(text);
    let whole = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(session.display_text().len()),
    };
    session
        .inspect_tables(session.revision(), whole)
        .unwrap_or_default()
}

/// Each table of each nonblank run of `text`, with its run's offset.
fn run_layouts(text: &str) -> Vec<(usize, Layout)> {
    let mut layouts = Vec::new();
    let mut run: Option<usize> = None;
    let mut at = 0;
    for line in text.split_inclusive('\n').chain(std::iter::once("")) {
        if line.trim_matches([' ', '\t', '\r', '\n']).is_empty() {
            if let Some(start) = run.take() {
                let tables = Layout::all(&text[start..at]);
                layouts.extend(tables.into_iter().map(|layout| (start, layout)));
            }
        } else {
            run.get_or_insert(at);
        }
        at += line.len();
    }
    layouts
}

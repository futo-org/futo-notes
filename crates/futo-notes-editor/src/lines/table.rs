//! Cells of a table line.
use super::inline::{Span, SpanKind};
use std::ops::Range;

/// The cells of a line that starts with `|`, as ranges into `row` between
/// unescaped pipes, untrimmed. Text after the last pipe is a cell only when
/// it is not blank. A line that does not start with `|` has no cells.
pub(crate) fn cells(row: &str) -> Vec<Range<usize>> {
    let bytes = row.as_bytes();
    if bytes.first() != Some(&b'|') {
        return Vec::new();
    }
    let mut cells = Vec::new();
    let mut start = 1;
    let mut at = 1;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => at += 2,
            b'|' => {
                cells.push(start..at);
                at += 1;
                start = at;
            }
            _ => at += 1,
        }
    }
    let end = bytes.len();
    if start < end && !row[start..end].trim_matches([' ', '\t']).is_empty() {
        cells.push(start..end);
    }
    cells
}

/// Each cell's content without its surrounding spaces and tabs.
pub(crate) fn trimmed(row: &str, cell: &Range<usize>) -> Range<usize> {
    let text = &row[cell.clone()];
    let lead = text.len() - text.trim_start_matches([' ', '\t']).len();
    let body = text.trim_matches([' ', '\t']);
    cell.start + lead..cell.start + lead + body.len()
}

/// A cell's marks with `\|` inside its code spans read as a pipe, as GFM
/// reads it: the pipe is text in its cell, so its backslash hides like an
/// escape's. Pairs are taken as `cells` takes them.
pub(crate) fn code_pipes(row: &str, mut spans: Vec<Span>) -> Vec<Span> {
    let bytes = row.as_bytes();
    let mut pipes = Vec::new();
    for span in spans.iter().filter(|span| span.kind == SpanKind::Code) {
        let mut at = span.open.end;
        while at < span.close.start {
            if bytes[at] != b'\\' {
                at += 1;
                continue;
            }
            if bytes.get(at + 1) == Some(&b'|') && at + 1 < span.close.start {
                pipes.push(Span {
                    kind: SpanKind::Escape,
                    range: at..at + 2,
                    open: at..at + 1,
                    close: at + 2..at + 2,
                });
            }
            at += 2;
        }
    }
    if !pipes.is_empty() {
        spans.extend(pipes);
        spans.sort_by_key(|span| (span.range.start, std::cmp::Reverse(span.range.end)));
    }
    spans
}

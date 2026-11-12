//! The note reader: every line is one block, read by its own text and a small
//! carry from the lines above (open fence, open front matter, the list lines
//! above, an open table). The one look back is the table header: a delimiter
//! row makes the line directly above it a header.
//!
//! The dialect is `docs/spec/editor/portable-core/linedown.md`; the cases are
//! `tests/fixtures/linedown/`.
#![allow(dead_code)] // Nothing calls the reader until the engine moves onto it.

pub(crate) mod block;
pub(crate) mod inline;
pub(crate) mod table;
pub(crate) mod url;

#[cfg(test)]
mod compare;
#[cfg(test)]
mod tests;

pub(crate) use block::{Carry, Kind, Line, TableRole};
#[cfg(test)]
use block::{FenceRole, FrontMatterRole};
pub(crate) use inline::{Span, SpanKind};
use std::ops::Range;

/// A whole note's reading: its lines, the carry before each, and each line's
/// inline marks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Reading {
    pub lines: Vec<Line>,
    pub carries: Vec<Carry>,
    pub spans: Vec<Vec<Span>>,
}

/// The inline marks of one line, by what the line is.
pub(crate) fn line_spans(source: &str, line: &Line) -> Vec<Span> {
    let text = &source[line.range.clone()];
    let base = line.range.start;
    let local = |range: &Range<usize>| range.start - base..range.end - base;
    let shift = |span: Span| shift_span(span, base);
    match &line.kind {
        Kind::Plain { .. } | Kind::Heading { .. } | Kind::List { .. } => {
            inline::read(text, local(&line.content))
                .into_iter()
                .map(shift)
                .collect()
        }
        Kind::Table {
            role: TableRole::Header | TableRole::Row,
            ..
        } => table::cells(text)
            .iter()
            .flat_map(|cell| inline::read(text, table::trimmed(text, cell)))
            .map(shift)
            .collect(),
        _ => Vec::new(),
    }
}

fn shift_span(mut span: Span, by: usize) -> Span {
    let shift = |range: &mut Range<usize>| *range = range.start + by..range.end + by;
    shift(&mut span.range);
    shift(&mut span.open);
    shift(&mut span.close);
    if let SpanKind::Image { alt, .. } = &mut span.kind {
        shift(alt);
    }
    span
}

impl Reading {
    pub fn new(source: &str) -> Self {
        let (lines, carries) = block::read(source);
        let spans = lines.iter().map(|line| line_spans(source, line)).collect();
        Self {
            lines,
            carries,
            spans,
        }
    }

    /// Re-read after `source` changed at `start`, where `removed` bytes became
    /// `inserted` bytes. Reads from one line above the edit (a table header)
    /// until the carry at a line start after the edit equals the one it had
    /// before. Returns the indices of the lines that were read again.
    pub fn update(
        &mut self,
        source: &str,
        start: usize,
        removed: usize,
        inserted: usize,
    ) -> Range<usize> {
        let old_end = start + removed;
        let new_end = start + inserted;
        let shift = |offset: usize| offset + inserted - removed;
        let mut first = self
            .lines
            .partition_point(|line| line.range.start <= start)
            .saturating_sub(1);
        first = first.saturating_sub(1);
        let mut carry = self.carries[first].clone();
        let mut at = self.lines[first].range.start;
        let mut old = first;
        let mut lines = Vec::new();
        let mut carries = Vec::new();
        loop {
            if at >= new_end {
                while old < self.lines.len()
                    && (self.lines[old].range.start < old_end
                        || shift(self.lines[old].range.start) < at)
                {
                    old += 1;
                }
                if old < self.lines.len()
                    && shift(self.lines[old].range.start) == at
                    && self.carries[old] == carry
                {
                    break;
                }
            }
            carries.push(carry.clone());
            let line = block::read_line(&mut carry, source, at);
            let last = line.ending == 0;
            at = line.end();
            block::place(&mut lines, line);
            if last {
                old = self.lines.len();
                break;
            }
        }
        for line in &mut self.lines[old..] {
            line.range = shift(line.range.start)..shift(line.range.end);
            line.marker = shift(line.marker.start)..shift(line.marker.end);
            line.content = shift(line.content.start)..shift(line.content.end);
            if let Kind::List { text, .. } = &mut line.kind {
                *text = shift(text.start)..shift(text.end);
            }
            if let Kind::Fence {
                language: Some(language),
                ..
            } = &mut line.kind
            {
                *language = shift(language.start)..shift(language.end);
            }
        }
        for spans in &mut self.spans[old..] {
            for span in spans.iter_mut() {
                *span = shift_span(span.clone(), inserted).clone();
                *span = unshift_span(span.clone(), removed);
            }
        }
        let read = lines.len();
        let spans: Vec<_> = lines.iter().map(|line| line_spans(source, line)).collect();
        self.lines.splice(first..old, lines);
        self.carries.splice(first..old, carries);
        self.spans.splice(first..old, spans);
        // A delimiter row the re-read stopped at keeps its header.
        if let Some(Kind::Table {
            role: TableRole::Delimiter,
            columns,
        }) = self.lines.get(first + read).map(|line| line.kind.clone())
        {
            let header = &mut self.lines[first + read - 1];
            header.kind = Kind::Table {
                role: TableRole::Header,
                columns,
            };
        }
        first..first + read
    }
}

fn unshift_span(mut span: Span, by: usize) -> Span {
    let shift = |range: &mut Range<usize>| *range = range.start - by..range.end - by;
    shift(&mut span.range);
    shift(&mut span.open);
    shift(&mut span.close);
    if let SpanKind::Image { alt, .. } = &mut span.kind {
        shift(alt);
    }
    span
}

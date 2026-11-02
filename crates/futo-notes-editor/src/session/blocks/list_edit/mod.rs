//! Generic list editing (DECISIONS #20). A command states the intended shape of
//! every row in its window. Rows whose shape and container columns survive keep
//! their exact bytes; the rest are respelled canonically around their original
//! body. The candidate must reparse to exactly the intended rows, after at most
//! a small fixed repair set (escape, blank line, empty-comment separator,
//! alternate marker); otherwise the command is refused before acceptance.
use super::*;
use crate::inline::ListLine;
use std::ops::Range;

mod ops;
mod plan;
mod repair;
mod shapes;
mod verify;
use plan::Plan;
use repair::{escape, repairs};

#[cfg(test)]
mod fuzz_tests;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Shape {
    pub quotes: usize,
    /// List depth; zero is unlisted.
    pub depth: usize,
    pub opens: bool,
    /// Interpreted number of an opening ordered row.
    pub ordinal: Option<u64>,
    pub checked: Option<bool>,
    pub heading: u8,
    /// Bullet character or ordered delimiter of an opening row.
    pub marker: u8,
}

impl Shape {
    fn ordered(&self) -> bool {
        matches!(self.marker, b'.' | b')')
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Insert {
    #[default]
    None,
    Blank,
    Comment,
}

pub(super) struct Row {
    /// Physical row without its line ending, and the end after that ending.
    line: Range<usize>,
    end: usize,
    /// Text after the container prefix; a retired heading keeps only content.
    body: Range<usize>,
    content: Range<usize>,
    quote_end: usize,
    pub before: Shape,
    pub after: Shape,
    pub list: Option<ListLine>,
    /// Opening rows of every item containing this row, outermost first.
    pub chain: Vec<Option<usize>>,
    pub code: bool,
    pub blank: bool,
    pub divider: bool,
    /// Owned syntax a canonical prefix cannot respell.
    fixed: bool,
    pub selected: bool,
    /// The intended row is an unlisted empty paragraph.
    pub exact_blank: bool,
    /// Start number for an ordered row that begins a list.
    pub start: Option<u64>,
    /// The start is the user's typed number, not the list's next ordinal.
    pub pinned: bool,
    /// Intended list identity: rows continue one list only with the same key.
    pub key: usize,
    /// Respell even when the shape is unchanged.
    pub forced: bool,
    escape: bool,
    escapable: bool,
    insert: Insert,
}

impl Row {
    pub fn changed(&self) -> bool {
        self.forced || !same_shape(&self.after, &self.before)
    }

    pub fn item(&self) -> Option<usize> {
        self.chain.last().copied().flatten()
    }

    pub fn retire_heading(&mut self) {
        if self.before.heading > 0 {
            self.body = self.content.clone();
            self.after.heading = 0;
        }
    }
}

impl EditorSession {
    /// Window rows with their current shapes; `after` starts equal to `before`.
    fn list_rows(&self, window: &Range<usize>, selected: &[usize]) -> Vec<Row> {
        let mut rows: Vec<Row> = Vec::new();
        let mut open: Vec<(Range<usize>, usize)> = Vec::new();
        for line in self.projection.list_command_lines_in_source(window) {
            let index = rows.len();
            let raw = self.source.byte_slice(line.source.clone()).to_string();
            let ending = if raw.ends_with("\r\n") {
                2
            } else {
                usize::from(raw.ends_with('\n') || raw.ends_with('\r'))
            };
            let text = &raw[..raw.len() - ending];
            let start = line.source.start;
            let mut fixed = line.fixed;
            let quotes = line.list.as_ref().map_or(line.quote_depth, |list| {
                fixed |= list.quote_depth != line.quote_depth;
                list.quote_depth
            });
            let quote_end = super::indent_source::quote_prefix_end(text, quotes);
            let mut chain = Vec::new();
            let mut physical = None;
            let mut body = quote_end;
            if let Some(list) = &line.list {
                open.retain(|(item, _)| item.start <= start && start < item.end);
                let opens = list.first && list.marker.start >= start;
                if opens {
                    open.push((list.item.clone(), index));
                }
                chain = open.iter().map(|(_, row)| Some(*row)).collect();
                if chain.len() > list.depth {
                    fixed = true;
                    chain.drain(..chain.len() - list.depth);
                }
                while chain.len() < list.depth {
                    fixed = true;
                    chain.insert(0, None);
                }
                let partial;
                (body, physical, partial) =
                    list_body(text, start, quote_end, list, opens, line.task.as_ref());
                fixed |= partial && (opens || line.code);
            } else {
                open.clear();
            }
            let opens = line
                .list
                .as_ref()
                .is_some_and(|list| chain.last() == Some(&Some(index)) && list.first);
            let marker = line
                .list
                .as_ref()
                .filter(|_| opens)
                .map_or(0, |list| self.source.byte(list.marker.end - 1));
            let shape = Shape {
                quotes,
                depth: line.list.as_ref().map_or(0, |list| list.depth),
                opens,
                ordinal: line
                    .list
                    .as_ref()
                    .and_then(|list| list.ordinal)
                    .filter(|_| opens),
                checked: line
                    .list
                    .as_ref()
                    .and_then(|list| list.checked)
                    .filter(|_| opens),
                heading: line.heading,
                marker,
            };
            let blank = !line.code && !opens && text[body..].trim().is_empty();
            let key = line
                .list
                .as_ref()
                .map_or(usize::MAX - index, |list| list.owner.start);
            rows.push(Row {
                line: start..start + text.len(),
                end: line.source.end,
                body: start + body..start + text.len(),
                content: line.content.clone(),
                quote_end: start + quote_end,
                before: shape.clone(),
                after: shape,
                list: line.list,
                chain,
                code: line.code,
                blank,
                divider: line.divider,
                fixed,
                selected: selected.contains(&start),
                exact_blank: false,
                start: physical,
                pinned: false,
                key,
                forced: false,
                escape: false,
                escapable: false,
                insert: Insert::None,
            });
        }
        rows
    }

    /// Plan, verify and repair, then commit one protected action.
    fn commit_rows(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        window: Range<usize>,
        mut rows: Vec<Row>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        shapes::number(&mut rows);
        for row in rows.iter_mut().filter(|row| row.changed()) {
            row.escapable = escape(&self.source.byte_slice(row.body.clone()).to_string()).is_some();
        }
        let mut work = EditWork::default();
        let Some(plan) = self.verified_plan(expected, &window, &mut rows, &mut work)? else {
            return Ok(None);
        };
        let (selection, _) = self
            .projection
            .source_selection(range, self.input_affinity(range));
        let selection = map_offset(&rows, &plan, selection.start.source.0)
            ..map_offset(&rows, &plan, selection.end.source.0);
        let formats = (range == self.selection)
            .then(|| self.pending_formats.clone())
            .flatten();
        let affinity = self.input_affinity(range);
        let mut change = self.commit_block_edit(
            expected,
            plan.span,
            &plan.text,
            BlockSelection::SourceRange(selection),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, formats, affinity);
        accumulate_planning_work(&mut change.work, work);
        Ok(Some(change))
    }

    /// The first plan that reparses as intended, trying each repair for the
    /// first mismatching row within a fixed budget; otherwise a refusal.
    fn verified_plan(
        &self,
        expected: Revision,
        window: &Range<usize>,
        rows: &mut [Row],
        work: &mut EditWork,
    ) -> Result<Option<Plan>, EditorError> {
        let Some(mut plan) = self.plan_rows(rows)? else {
            return Ok(None);
        };
        let mut bad = self.verify_rows(expected, window, rows, &plan, work)?;
        let mut budget = 8;
        while let Some(at) = bad {
            let mut repaired = false;
            for option in repairs(rows, at) {
                if budget == 0 {
                    break;
                }
                budget -= 1;
                let saved: Vec<_> = rows
                    .iter()
                    .map(|row| (row.escape, row.insert, row.after.marker))
                    .collect();
                option.apply(rows);
                if let Some(candidate) = self.plan_rows(rows).ok().flatten() {
                    let result = self.verify_rows(expected, window, rows, &candidate, work)?;
                    if result.is_none_or(|next| next > at) {
                        (plan, bad, repaired) = (candidate, result, true);
                        break;
                    }
                }
                for (row, (escape, insert, marker)) in rows.iter_mut().zip(saved) {
                    row.escape = escape;
                    row.insert = insert;
                    row.after.marker = marker;
                }
            }
            if !repaired {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        Ok(Some(plan))
    }
}

/// An original source offset in the planned output: inside a body it keeps its
/// place (past an escape), inside a respelled prefix it moves to the body.
fn map_offset(rows: &[Row], plan: &Plan, offset: usize) -> usize {
    let index = rows
        .partition_point(|row| row.end <= offset)
        .min(rows.len() - 1);
    let row = &rows[index];
    let (line, body) = plan.starts[index];
    if offset < row.line.start {
        (offset as isize + body as isize - row.body.start as isize).max(0) as usize
    } else if offset >= row.body.start {
        let offset = offset.min(row.body.end);
        let shift = plan.escapes[index]
            .filter(|(at, _)| offset > row.body.start + at)
            .map_or(0, |(_, delta)| delta);
        (body + offset - row.body.start).saturating_add_signed(shift)
    } else {
        body.max(line)
    }
}

/// Interpreted numbers may change around a kept row without respelling it.
fn same_shape(a: &Shape, b: &Shape) -> bool {
    Shape {
        ordinal: None,
        ..a.clone()
    } == Shape {
        ordinal: None,
        ..b.clone()
    }
}

/// Where a list row's body starts after its container prefix, the physical
/// number of an ordered marker, and whether a tab straddles the content column.
fn list_body(
    text: &str,
    start: usize,
    quote_end: usize,
    list: &ListLine,
    opens: bool,
    task: Option<&Range<usize>>,
) -> (usize, Option<u64>, bool) {
    if !opens {
        let column = crate::inline::columns(&text[..quote_end], 0);
        let (end, partial) = skip_columns(text, quote_end, column, list.content_column);
        return (end, None, partial);
    }
    let marker = &text[list.marker.start - start..list.marker.end - start];
    let physical = marker
        .trim_end_matches(['.', ')'])
        .parse::<u64>()
        .ok()
        .filter(|_| list.ordinal.is_some());
    let at = list.marker.end - start;
    let column = crate::inline::columns(&text[..at], 0);
    let (end, partial) = skip_columns(text, at, column, list.content_column);
    let body = match task {
        Some(task) => {
            let end = task.end - start;
            end + usize::from(matches!(text.as_bytes().get(end), Some(b' ')))
        }
        None => end,
    };
    (body, physical, partial)
}

/// Consume container indentation up to `target`; a tab crossing it is partial.
fn skip_columns(text: &str, mut at: usize, mut column: usize, target: usize) -> (usize, bool) {
    while column < target {
        match text.as_bytes().get(at) {
            Some(b' ') => column += 1,
            Some(b'\t') => {
                let next = column + 4 - column % 4;
                if next > target {
                    return (at, true);
                }
                column = next;
            }
            _ => break,
        }
        at += 1;
    }
    (at, false)
}

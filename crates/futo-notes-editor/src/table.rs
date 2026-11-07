//! GFM table layout over one window of exact source, and the byte splices that
//! structural commands write. Views never see pipes or the delimiter row; they
//! receive cells and ask for commands. Offsets here are window-relative.
use std::ops::Range;

mod scan;
#[cfg(test)]
mod scan_tests;
mod types;
#[cfg(test)]
use scan::Header;
pub(crate) use scan::{RowScan, State, Summary};
pub use types::*;

pub(crate) struct Line {
    pub start: usize,
    /// End of content, before any line ending.
    pub end: usize,
    /// Start of the next line (after the line ending).
    pub next: usize,
    pub lead: Option<usize>,
    pub trail: Option<usize>,
    /// Raw text between delimiting pipes, padding included.
    pub cells: Vec<Range<usize>>,
    pub pipes: usize,
}

pub(crate) struct Layout {
    /// Header, delimiter, then body rows.
    pub lines: Vec<Line>,
    pub columns: usize,
    pub alignments: Vec<TableAlignment>,
}

pub(crate) struct Splice {
    pub at: usize,
    pub remove: usize,
    pub text: String,
}

fn unescaped_pipes(text: &str, start: usize, end: usize) -> Vec<usize> {
    let bytes = text.as_bytes();
    let mut pipes = Vec::new();
    let mut slashes = 0;
    for (at, byte) in bytes.iter().enumerate().take(end).skip(start) {
        match byte {
            b'\\' => slashes += 1,
            b'|' => {
                if slashes % 2 == 0 {
                    pipes.push(at);
                }
                slashes = 0;
            }
            _ => slashes = 0,
        }
    }
    pipes
}

/// Whether `range` (relative to `line`, one physical line without its
/// ending) lies inside one cell of that line read as a table row. Cells come
/// from the line alone, so `false` means no table can give it a cell.
pub(crate) fn line_has_cell(line: &str, range: Range<usize>) -> bool {
    parse_line(line, 0, line.len(), line.len())
        .cells
        .iter()
        .any(|cell| cell.start <= range.start && range.end <= cell.end)
}

/// Canonical shape of one physical row, without a fabricated table window.
pub(crate) fn row_line(text: &str) -> Line {
    let end = text.trim_end_matches(['\r', '\n']).len();
    parse_line(text, 0, end, text.len())
}

pub(crate) fn pipe_count(text: &str) -> usize {
    unescaped_pipes(text, 0, text.len()).len()
}

fn parse_line(text: &str, start: usize, end: usize, next: usize) -> Line {
    let bytes = text.as_bytes();
    let mut first = start;
    while first < end && matches!(bytes[first], b' ' | b'\t') {
        first += 1;
    }
    let mut last = end;
    while last > first && matches!(bytes[last - 1], b' ' | b'\t') {
        last -= 1;
    }
    let mut pipes = unescaped_pipes(text, first, last);
    let total = pipes.len();
    let lead = (pipes.first() == Some(&first)).then(|| pipes.remove(0));
    let trail = (pipes.last().is_some_and(|pipe| *pipe + 1 == last)).then(|| pipes.pop().unwrap());
    let mut cells = Vec::new();
    if total == 0 {
        if first < last {
            cells.push(start..end);
        }
    } else {
        let mut from = lead.map_or(start, |lead| lead + 1);
        // A lone leading pipe owns no cell.
        if !(lead.is_some() && trail.is_none() && pipes.is_empty() && from >= last) {
            for pipe in pipes.iter().copied() {
                cells.push(from..pipe);
                from = pipe + 1;
            }
            cells.push(from..trail.unwrap_or(end).max(from));
        }
    }
    Line {
        start,
        end,
        next,
        lead,
        trail,
        cells,
        pipes: total,
    }
}

fn delimiter(text: &str, line: &Line) -> Option<Vec<TableAlignment>> {
    if line.pipes == 0 || line.cells.is_empty() {
        return None;
    }
    line.cells
        .iter()
        .map(|cell| {
            let raw = text[cell.clone()].trim_matches([' ', '\t']);
            let body = raw.strip_prefix(':').unwrap_or(raw);
            let left = body.len() != raw.len();
            let body = body.strip_suffix(':').unwrap_or(body);
            let right = raw.len() - usize::from(left) != body.len();
            (!body.is_empty() && body.bytes().all(|byte| byte == b'-')).then_some(
                match (left, right) {
                    (true, true) => TableAlignment::Center,
                    (true, false) => TableAlignment::Left,
                    (false, true) => TableAlignment::Right,
                    _ => TableAlignment::None,
                },
            )
        })
        .collect()
}

/// A line that starts another block ends the table instead of becoming a row.
fn interrupts(line: &str) -> bool {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return false;
    }
    let line = line[indent..].trim_end_matches(['\r', '\n']);
    let first = line.bytes().next().unwrap_or(b' ');
    let hashes = line.bytes().take_while(|byte| *byte == b'#').count();
    let marker = matches!(first, b'-' | b'+' | b'*')
        && matches!(line.as_bytes().get(1), None | Some(b' ' | b'\t'));
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    let ordered = (1..=9).contains(&digits)
        && matches!(line.as_bytes().get(digits), Some(b'.' | b')'))
        && matches!(line.as_bytes().get(digits + 1), None | Some(b' ' | b'\t'));
    let compact: String = line
        .chars()
        .filter(|ch| !matches!(ch, ' ' | '\t'))
        .collect();
    let rule = compact.len() >= 3
        && matches!(first, b'-' | b'*' | b'_')
        && compact.bytes().all(|byte| byte == first);
    first == b'>'
        || ((1..=6).contains(&hashes)
            && matches!(line.as_bytes().get(hashes), None | Some(b' ' | b'\t')))
        || line.starts_with("```")
        || line.starts_with("~~~")
        || marker
        || ordered
        || rule
}

impl Layout {
    /// The table in `text` (a run of nonblank lines) that contains `target`.
    pub fn find(text: &str, target: usize) -> Option<Self> {
        Self::scan(text, Some(target)).pop()
    }

    /// Every table in the run, in order.
    pub fn all(text: &str) -> Vec<Self> {
        Self::scan(text, None)
    }

    /// One pass over the run: the tables in it, or with a target just the one
    /// containing it (the scan stops there).
    fn scan(text: &str, target: Option<usize>) -> Vec<Self> {
        let mut spans = Vec::new();
        let mut at = 0;
        for line in text.split_inclusive('\n') {
            let end = at + line.trim_end_matches(['\r', '\n']).len();
            spans.push((at, end, at + line.len()));
            at += line.len();
        }
        let target = target.map(|offset| {
            spans
                .partition_point(|(_, _, next)| *next <= offset)
                .min(spans.len().saturating_sub(1))
        });
        let mut tables = Vec::new();
        let mut header = 0;
        while header + 1 < spans.len() && target.is_none_or(|target| header <= target) {
            let head = parse_line(text, spans[header].0, spans[header].1, spans[header].2);
            let rule = parse_line(
                text,
                spans[header + 1].0,
                spans[header + 1].1,
                spans[header + 1].2,
            );
            let alignments = delimiter(text, &rule);
            if let Some(alignments) = alignments.filter(|alignments| {
                head.pipes > 0 && !head.cells.is_empty() && head.cells.len() == alignments.len()
            }) {
                let mut lines = vec![head, rule];
                for &(start, end, next) in &spans[header + 2..] {
                    if interrupts(&text[start..end]) {
                        break;
                    }
                    lines.push(parse_line(text, start, end, next));
                }
                let count = lines.len();
                let hit = target.is_none_or(|target| header + count > target);
                if hit {
                    tables.push(Self {
                        columns: alignments.len(),
                        alignments,
                        lines,
                    });
                    if target.is_some() {
                        break;
                    }
                }
                header += count;
            } else {
                header += 1;
            }
        }
        tables
    }

    pub fn rows(&self) -> usize {
        self.lines.len() - 1
    }

    pub fn row_line(&self, row: usize) -> &Line {
        &self.lines[if row == 0 { 0 } else { row + 1 }]
    }

    /// Cell content: the raw text without one run of edge padding. An empty
    /// cell's point sits after its first padding space, where typing lands.
    pub fn content(text: &str, raw: &Range<usize>) -> Range<usize> {
        let slice = &text[raw.clone()];
        let trimmed = slice.trim_matches([' ', '\t']);
        if trimmed.is_empty() {
            let at = raw.start + usize::from(slice.starts_with([' ', '\t']));
            return at..at;
        }
        let start = raw.start + slice.len() - slice.trim_start_matches([' ', '\t']).len();
        start..start + trimmed.len()
    }

    /// The addressed cell when `range` lies wholly inside one cell's raw span.
    pub fn locate(&self, range: Range<usize>) -> Option<(usize, usize)> {
        let index = self
            .lines
            .partition_point(|line| line.next <= range.start)
            .min(self.lines.len() - 1);
        let line = &self.lines[index];
        if index == 1 || range.end > line.end || range.start < line.start {
            return None;
        }
        let column = line
            .cells
            .iter()
            .position(|cell| cell.start <= range.start && range.end <= cell.end)?;
        (column < self.columns).then_some((if index == 0 { 0 } else { index - 1 }, column))
    }

    pub fn controls(&self, row: usize) -> TableControls {
        TableControls {
            insert_row_above: row >= 1,
            insert_row_below: true,
            delete_row: row >= 1 && self.rows() >= 3,
            insert_column_left: true,
            insert_column_right: true,
            delete_column: self.columns > 1,
        }
    }

    pub fn eol<'a>(&self, text: &'a str, line: &Line) -> &'a str {
        if line.next > line.end {
            &text[line.end..line.next]
        } else {
            self.lines
                .iter()
                .find(|other| other.next > other.end)
                .map_or("\n", |other| &text[other.end..other.next])
        }
    }

    fn blank_row(&self) -> String {
        format!("|{}", "  |".repeat(self.columns))
    }

    /// An empty body row after `row`; header-only tables gain their first row.
    pub fn insert_row(&self, text: &str, row: usize, below: bool) -> Vec<Splice> {
        let line = if below && row == 0 {
            &self.lines[1]
        } else {
            self.row_line(row)
        };
        let eol = self.eol(text, line);
        let row_text = self.blank_row();
        if below && line.next == line.end {
            vec![Splice {
                at: line.end,
                remove: 0,
                text: format!("{eol}{row_text}"),
            }]
        } else {
            let at = if below { line.next } else { line.start };
            vec![Splice {
                at,
                remove: 0,
                text: format!("{row_text}{eol}"),
            }]
        }
    }

    pub fn delete_row(&self, row: usize) -> Vec<Splice> {
        let line = self.row_line(row);
        let (at, to) = if line.next > line.end {
            (line.start, line.next)
        } else {
            (self.lines[if row <= 1 { 1 } else { row }].end, line.end)
        };
        vec![Splice {
            at,
            remove: to - at,
            text: String::new(),
        }]
    }

    /// Extend a short body row with empty cells up to the table's width.
    pub fn fill_row(&self, row: usize) -> Vec<Splice> {
        let line = self.row_line(row);
        let missing = self.columns.saturating_sub(line.cells.len());
        if missing == 0 {
            return Vec::new();
        }
        let cells = "  |".repeat(missing);
        vec![match line.trail {
            Some(trail) => Splice {
                at: trail + 1,
                remove: 0,
                text: cells,
            },
            // A lone pipe already opens the first cell.
            None if line.lead.is_some() && line.cells.is_empty() => Splice {
                at: line.end,
                remove: 0,
                text: cells,
            },
            None => Splice {
                at: line.end,
                remove: 0,
                text: format!(" |{cells}"),
            },
        }]
    }

    pub fn insert_column(&self, at: usize) -> Vec<Splice> {
        let mut splices = Vec::new();
        for (index, line) in self.lines.iter().enumerate() {
            let count = line.cells.len();
            if at > count || (count < self.columns && at >= count) {
                continue;
            }
            let cell = if index == 1 { " --- " } else { "  " };
            splices.push(if at < count {
                let start = line.cells[at].start;
                Splice {
                    at: start,
                    remove: 0,
                    text: if at == 0 && line.lead.is_none() {
                        format!("|{cell}| ")
                    } else {
                        format!("{cell}|")
                    },
                }
            } else if let Some(trail) = line.trail {
                Splice {
                    at: trail + 1,
                    remove: 0,
                    text: format!("{cell}|"),
                }
            } else {
                Splice {
                    at: line.end,
                    remove: 0,
                    text: format!(" |{cell}|"),
                }
            });
        }
        splices
    }

    pub fn delete_column(&self, text: &str, at: usize) -> Vec<Splice> {
        let mut splices = Vec::new();
        for line in &self.lines {
            let count = line.cells.len();
            if at >= count {
                continue;
            }
            let cell = &line.cells[at];
            splices.push(
                if line.lead.is_none() && line.trail.is_none() && line.pipes <= 1 {
                    // The deletion would leave no pipe, and the row would stop
                    // being a table row: rewrite it with its remaining cell.
                    let kept = line.cells.get(1 - at.min(1)).filter(|_| count == 2);
                    let kept = kept.map_or("", |raw| text[raw.clone()].trim_matches([' ', '\t']));
                    let body = &text[line.start..line.end];
                    let first =
                        line.start + body.len() - body.trim_start_matches([' ', '\t']).len();
                    let last = line.start + body.trim_end_matches([' ', '\t']).len();
                    Splice {
                        at: first,
                        remove: last.saturating_sub(first),
                        text: format!("| {kept} |"),
                    }
                } else if count == 1 {
                    Splice {
                        at: cell.start,
                        remove: cell.len(),
                        text: "  ".into(),
                    }
                } else if at + 1 < count {
                    Splice {
                        at: cell.start,
                        remove: cell.len() + 1,
                        text: String::new(),
                    }
                } else {
                    Splice {
                        at: cell.start - 1,
                        remove: cell.len() + 1,
                        text: String::new(),
                    }
                },
            );
        }
        splices
    }
}

/// One contiguous replacement equivalent to `splices` (ascending, disjoint).
pub(crate) fn combine(text: &str, splices: &[Splice]) -> Option<(Range<usize>, String)> {
    let first = splices.first()?;
    let last = splices.last()?;
    let end = last.at + last.remove;
    let mut inserted = String::new();
    let mut at = first.at;
    for splice in splices {
        inserted.push_str(&text[at..splice.at]);
        inserted.push_str(&splice.text);
        at = splice.at + splice.remove;
    }
    Some((first.at..end, inserted))
}

pub(crate) fn apply(text: &str, splices: &[Splice]) -> String {
    combine(text, splices).map_or_else(
        || text.to_owned(),
        |(range, inserted)| format!("{}{inserted}{}", &text[..range.start], &text[range.end..]),
    )
}

/// Plain text pasted into one cell: edge blank lines go, and every other run
/// of whitespace that holds a line break becomes one space. Edge spaces and
/// tabs that do not touch a break are the pasted text.
pub(crate) fn flatten_for_cell(text: &str) -> String {
    let mut rest = text;
    loop {
        let blank = rest.len() - rest.trim_start_matches([' ', '\t']).len();
        match rest[blank..].strip_prefix("\r\n").or_else(|| {
            rest[blank..]
                .strip_prefix('\n')
                .or_else(|| rest[blank..].strip_prefix('\r'))
        }) {
            Some(after) => rest = after,
            None => break,
        }
    }
    loop {
        let trimmed = rest.trim_end_matches([' ', '\t']);
        match trimmed.strip_suffix("\r\n").or_else(|| {
            trimmed
                .strip_suffix('\n')
                .or_else(|| trimmed.strip_suffix('\r'))
        }) {
            Some(before) => rest = before,
            None => break,
        }
    }
    let mut result = String::with_capacity(rest.len());
    let mut run = String::new();
    for ch in rest.chars() {
        if ch.is_whitespace() {
            run.push(ch);
            continue;
        }
        flush_run(&mut result, &mut run);
        result.push(ch);
    }
    flush_run(&mut result, &mut run);
    result
}

fn flush_run(result: &mut String, run: &mut String) {
    if run.contains(['\n', '\r']) {
        result.push(' ');
    } else {
        result.push_str(run);
    }
    run.clear();
}

//! Canonical physical table lines: raw pipe parity, padding, cells, rules
//! and block interruptions. Layout and retained row facts share this owner.
use super::TableAlignment;
use std::ops::Range;

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

#[derive(Default)]
pub(crate) struct PipeScan {
    pub(super) positions: Vec<usize>,
    slashes: usize,
}
impl PipeScan {
    pub fn observe(&mut self, at: usize, ch: char) {
        match ch {
            '\\' => self.slashes += 1,
            '|' => {
                if self.slashes % 2 == 0 {
                    self.positions.push(at);
                }
                self.slashes = 0;
            }
            _ => self.slashes = 0,
        }
    }
}
pub(crate) fn unescaped_pipes(text: &str, start: usize, end: usize) -> Vec<usize> {
    let mut scan = PipeScan::default();
    for (at, byte) in text.as_bytes().iter().enumerate().take(end).skip(start) {
        scan.observe(at, char::from(*byte));
    }
    scan.positions
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

/// Canonical padding boundaries, including the bytes that stop both walks.
pub(super) fn line_bounds(text: &str, start: usize, end: usize) -> (Range<usize>, usize) {
    let bytes = text.as_bytes();
    let mut read = 0;
    let mut first = start;
    while first < end {
        read += 1;
        if !matches!(bytes[first], b' ' | b'\t') {
            break;
        }
        first += 1;
    }
    let mut last = end;
    while last > first {
        read += 1;
        if !matches!(bytes[last - 1], b' ' | b'\t') {
            break;
        }
        last -= 1;
    }
    (first..last, read)
}
pub(super) fn parse_line(text: &str, start: usize, end: usize, next: usize) -> Line {
    let (bounds, _) = line_bounds(text, start, end);
    let pipes = unescaped_pipes(text, bounds.start, bounds.end);
    line_from_pipes(start, end, next, bounds, pipes)
}
/// The same border/cell assembly accepts canonical pipe offsets already
/// observed during a Row's raw-source walk; no second pipe scan is needed.
pub(super) fn line_from_pipes(
    start: usize,
    end: usize,
    next: usize,
    bounds: Range<usize>,
    mut pipes: Vec<usize>,
) -> Line {
    let (first, last) = (bounds.start, bounds.end);
    pipes.retain(|at| first <= *at && *at < last);
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

pub(super) fn delimiter(text: &str, line: &Line) -> Option<Vec<TableAlignment>> {
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
pub(super) fn interrupts(line: &str) -> bool {
    interrupts_counted(line).0
}

/// Same canonical interruption test, exposing the source prefix/rule bytes
/// inspected when a retained pipeless line needs no full cell parse.
pub(super) fn interrupts_counted(line: &str) -> (bool, usize) {
    let bytes = line.as_bytes();
    let mut end = bytes.len();
    while end > 0 && matches!(bytes[end - 1], b'\r' | b'\n') {
        end -= 1;
    }
    let suffix = bytes.len() - end;
    let read = std::cell::Cell::new(0);
    let byte = |at: usize| {
        let value = bytes.get(at).copied().filter(|_| at < end);
        if value.is_some() {
            read.set(read.get().max(at + 1));
        }
        value
    };
    let result = (|| {
        let mut indent = 0;
        while byte(indent) == Some(b' ') {
            indent += 1;
            if indent > 3 {
                return false;
            }
        }
        let first = byte(indent).unwrap_or(b' ');
        let next = |at| matches!(byte(at), None | Some(b' ' | b'\t'));
        if first == b'>' {
            return true;
        }
        if first == b'#' {
            let mut hashes = 0;
            while hashes < 7 && byte(indent + hashes) == Some(b'#') {
                hashes += 1;
            }
            return hashes <= 6 && next(indent + hashes);
        }
        if matches!(first, b'`' | b'~') {
            return byte(indent + 1) == Some(first) && byte(indent + 2) == Some(first);
        }
        if matches!(first, b'-' | b'+' | b'*') && next(indent + 1) {
            return true;
        }
        if first.is_ascii_digit() {
            let mut digits = 0;
            while digits < 10 && byte(indent + digits).is_some_and(|b| b.is_ascii_digit()) {
                digits += 1;
            }
            return digits <= 9
                && matches!(byte(indent + digits), Some(b'.' | b')'))
                && next(indent + digits + 1);
        }
        if !matches!(first, b'-' | b'*' | b'_') {
            return false;
        }
        let mut signs = 0;
        for at in indent..end {
            match byte(at).unwrap() {
                b' ' | b'\t' => {}
                value if value == first => signs += 1,
                _ => return false,
            }
        }
        signs >= 3
    })();
    (
        result,
        (read.get() + suffix + usize::from(end > read.get())).min(bytes.len()),
    )
}

//! Which byte ranges of a note are not read for tags: front matter, fenced
//! code and code spans, as the text-first editor's line reader reads them
//! (docs/spec/editor/portable-core/linedown.md). A line ends at `\n` or
//! `\r\n`; a lone `\r` is an ordinary character. Fences and front matter are
//! whole lines; a code span never crosses a line.

use std::collections::HashMap;

/// One line: where it starts, where its text ends (before `\n` or `\r\n`),
/// and where the next line starts.
struct Line {
    start: usize,
    end: usize,
    next: usize,
}

fn lines(content: &str) -> impl Iterator<Item = Line> + '_ {
    let bytes = content.as_bytes();
    let mut start = Some(0);
    std::iter::from_fn(move || {
        let from = start?;
        let line = match memchr::memchr(b'\n', &bytes[from..]) {
            Some(offset) => {
                let newline = from + offset;
                let end = if newline > from && bytes[newline - 1] == b'\r' {
                    newline - 1
                } else {
                    newline
                };
                Line {
                    start: from,
                    end,
                    next: newline + 1,
                }
            }
            None => Line {
                start: from,
                end: bytes.len(),
                next: bytes.len(),
            },
        };
        start = (line.next < bytes.len() || line.end < line.next).then_some(line.next);
        Some(line)
    })
}

/// Sorted byte ranges that are code or front matter. No two touch, so a
/// region's end is never another's start.
pub(super) fn code_regions(content: &str) -> Vec<(usize, usize)> {
    let bytes = content.as_bytes();
    if memchr::memchr2(b'`', b'~', bytes).is_none() && !content.starts_with("---") {
        return Vec::new();
    }
    let mut regions = Vec::new();
    let mut lines = lines(content).peekable();
    if let Some(close) = front_matter_end(content) {
        regions.push((0, close));
        while lines.next_if(|line| line.start < close).is_some() {}
    }
    let mut fence: Option<(u8, usize, usize)> = None;
    for line in lines {
        let text = &content[line.start..line.end];
        let own = text.trim_start_matches([' ', '\t']);
        if let Some((ch, len, start)) = fence {
            let body = own.trim_end_matches([' ', '\t']);
            let run = body.bytes().take_while(|&b| b == ch).count();
            if run >= len && run == body.len() {
                regions.push((start, line.end));
                fence = None;
            }
        } else if let Some((ch, run)) = fence_open(own) {
            fence = Some((ch, run, line.start));
        } else {
            code_spans(bytes, line.start, line.end, &mut regions);
        }
    }
    if let Some((_, _, start)) = fence {
        regions.push((start, content.len()));
    }
    regions
}

/// Where closed front matter ends (after its closing `---`): only when line 1
/// is exactly `---` and a later line is exactly `---`.
fn front_matter_end(content: &str) -> Option<usize> {
    let mut lines = lines(content);
    let first = lines.next()?;
    if &content[first.start..first.end] != "---" {
        return None;
    }
    lines
        .find(|line| &content[line.start..line.end] == "---")
        .map(|line| line.end)
}

/// Three or more backticks or tildes at the start of a line's own text.
fn fence_open(own: &str) -> Option<(u8, usize)> {
    let ch = *own.as_bytes().first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let run = own.bytes().take_while(|&b| b == ch).count();
    (run >= 3).then_some((ch, run))
}

/// The code spans of `bytes[start..end]`, one line, read left to right as
/// the editor reads them: a `\` before ASCII punctuation is an escape; a
/// backtick run opens a span closed by the next run of exactly its length
/// and is literal text when none follows. Linear: each run length keeps a
/// cursor into its own list of runs, and openers only move forward.
fn code_spans(bytes: &[u8], start: usize, end: usize, regions: &mut Vec<(usize, usize)>) {
    let line = &bytes[start..end];
    if memchr::memchr(b'`', line).is_none() {
        return;
    }
    // Every maximal backtick run on the line, grouped by length.
    let mut runs: HashMap<usize, (Vec<usize>, usize)> = HashMap::new();
    let mut at = 0;
    while let Some(offset) = memchr::memchr(b'`', &line[at..]) {
        let run_start = at + offset;
        let run_end = run_end(line, run_start);
        runs.entry(run_end - run_start)
            .or_default()
            .0
            .push(run_start);
        at = run_end;
    }
    let mut i = 0;
    while i < line.len() {
        match line[i] {
            b'\\' if line.get(i + 1).is_some_and(u8::is_ascii_punctuation) => i += 2,
            b'`' => {
                let open_end = run_end(line, i);
                let len = open_end - i;
                let close = runs.get_mut(&len).and_then(|(starts, cursor)| {
                    while starts.get(*cursor).is_some_and(|&s| s < open_end) {
                        *cursor += 1;
                    }
                    starts.get(*cursor).copied()
                });
                match close {
                    Some(close) => {
                        regions.push((start + i, start + close + len));
                        i = close + len;
                    }
                    None => i = open_end,
                }
            }
            _ => i += 1,
        }
    }
}

fn run_end(bytes: &[u8], start: usize) -> usize {
    start + bytes[start..].iter().take_while(|&&b| b == b'`').count()
}

/// Point queries against sorted, disjoint ranges.
pub(super) struct RegionCursor<'a> {
    regions: &'a [(usize, usize)],
}

impl<'a> RegionCursor<'a> {
    pub(super) fn new(regions: &'a [(usize, usize)]) -> Self {
        Self { regions }
    }

    /// True if `pos` lies inside some region (`start <= pos < end`).
    pub(super) fn covers(&self, pos: usize) -> bool {
        match self.regions.binary_search_by(|&(start, _)| start.cmp(&pos)) {
            Ok(_) => true,
            Err(idx) => idx > 0 && self.regions[idx - 1].1 > pos,
        }
    }

    /// True if some region ends exactly at `pos`.
    pub(super) fn immediately_after_region(&self, pos: usize) -> bool {
        self.regions
            .binary_search_by(|&(_, end)| end.cmp(&pos))
            .is_ok()
    }
}

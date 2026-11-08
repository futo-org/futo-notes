//! Block meaning comes from CommonMark events; marker spelling stays in source.
use pulldown_cmark::{Event, Tag};
use std::ops::Range;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum HeadingSyntax {
    #[default]
    None,
    Atx,
    Setext,
}

/// Body-free command metadata copied from retained canonical attribution.
/// Original physical body vectors stay borrowed in the projection.
pub(crate) struct ListCommandLine {
    pub source: Range<usize>,
    pub content: Range<usize>,
    pub heading: u8,
    pub quote_depth: usize,
    pub divider: bool,
    pub code: bool,
    pub list: Option<super::lists::ListLine>,
    pub task: Option<Range<usize>>,
    /// Syntax a generic list edit cannot respell: setext/multi-line bodies,
    /// raw HTML, front matter.
    pub fixed: bool,
}

impl ListCommandLine {
    pub(crate) fn from_block(block: &BlockLine, base: usize) -> Self {
        let shift = |range: &Range<usize>| base + range.start..base + range.end;
        let mut list = block.list.clone();
        if let Some(list) = &mut list {
            list.shift(base);
        }
        Self {
            source: shift(&block.source),
            content: shift(&block.content),
            heading: block.heading,
            quote_depth: block.quote_depth,
            divider: block.divider,
            code: block.code,
            list,
            task: block.task.as_ref().map(shift),
            fixed: block.bodies.len() > 1
                || block.underline.is_some()
                || block.html
                || block.metadata
                || block.heading_syntax == HeadingSyntax::Setext,
        }
    }
}

/// A physical line retains its exact prefix, body and line-ending boundaries.
#[derive(Clone, Debug)]
pub(crate) struct PhysicalLine {
    pub source: Range<usize>,
    pub content: Range<usize>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct BlockLine {
    pub source: Range<usize>,
    pub content: Range<usize>,
    pub heading: u8,
    pub heading_syntax: HeadingSyntax,
    pub quote_depth: usize,
    pub quote_start: bool,
    pub divider: bool,
    pub code: bool,
    /// Leading front matter: inert, never Markdown.
    pub metadata: bool,
    /// Raw HTML block source; Markdown shortcuts never fire inside it.
    pub html: bool,
    /// Nonempty source within an actual paragraph or tight-item inline run.
    pub paragraph_text: bool,
    pub list: Option<super::lists::ListLine>,
    pub task: Option<Range<usize>>,
    pub in_list: bool,
    pub code_language: Option<String>,
    pub fence: Option<super::fences::Fence>,
    pub bodies: Vec<PhysicalLine>,
    pub underline: Option<PhysicalLine>,
}

impl BlockLine {
    pub(crate) fn shift(&mut self, by: usize) {
        for range in [&mut self.source, &mut self.content] {
            range.start += by;
            range.end += by;
        }
        if let Some(fence) = &mut self.fence {
            fence.shift(by);
        }
        if let Some(list) = &mut self.list {
            list.shift(by);
        }
        if let Some(task) = &mut self.task {
            task.start += by;
            task.end += by;
        }
        for physical in self.bodies.iter_mut().chain(self.underline.iter_mut()) {
            physical.source.start += by;
            physical.source.end += by;
            physical.content.start += by;
            physical.content.end += by;
        }
    }
}

/// Find trailing syntax in the canonical physical source partition. Construction
/// starts with consecutive physical lines; setext coalesces consecutive entries
/// and fences change only content/metadata. Thus starts and ends stay ordered,
/// with content contained in source (including the optional empty EOF entry).
/// Any match of the original predicate must have source.end >= range.end and
/// source.start <= range.start. Keep both boundaries inclusive: an empty range
/// at a shared edge may match either neighbor. The final predicate is unchanged.
pub(super) fn trailing_syntax(lines: &[BlockLine], range: &Range<usize>) -> bool {
    let first = lines.partition_point(|line| line.source.end < range.end);
    let last = lines.partition_point(|line| line.source.start <= range.start);
    first < last
        && lines[first..last]
            .iter()
            .any(|block| block.content.end <= range.start && range.end <= block.source.end)
}

pub(super) fn describe(
    source: &str,
    events: &[(Event<'_>, Range<usize>)],
) -> (Vec<BlockLine>, Vec<Range<usize>>) {
    describe_with_items(source, events, mark_item_lines)
}

fn describe_with_items(
    source: &str,
    events: &[(Event<'_>, Range<usize>)],
    mark_items: impl Fn(&mut [BlockLine], &Range<usize>),
) -> (Vec<BlockLine>, Vec<Range<usize>>) {
    describe_with_parts(source, events, mark_items, super::fences::describe)
}

fn describe_with_parts(
    source: &str,
    events: &[(Event<'_>, Range<usize>)],
    mark_items: impl Fn(&mut [BlockLine], &Range<usize>),
    fences: impl Fn(&str, &[(Event<'_>, Range<usize>)], &mut [BlockLine]),
) -> (Vec<BlockLine>, Vec<Range<usize>>) {
    let mut at = 0;
    let mut lines: Vec<_> = source
        .split_inclusive('\n')
        .map(|line| {
            let start = at;
            at += line.len();
            BlockLine {
                source: start..at,
                content: start..start + line.trim_end_matches(['\r', '\n']).len(),
                heading: 0,
                heading_syntax: HeadingSyntax::None,
                quote_depth: 0,
                quote_start: false,
                divider: false,
                code: false,
                metadata: false,
                html: false,
                paragraph_text: false,
                list: None,
                task: None,
                in_list: false,
                code_language: None,
                fence: None,
                bodies: Vec::new(),
                underline: None,
            }
        })
        .collect();
    if lines.is_empty() || source.ends_with('\n') {
        lines.push(BlockLine {
            source: at..at,
            content: at..at,
            heading: 0,
            heading_syntax: HeadingSyntax::None,
            quote_depth: 0,
            quote_start: false,
            divider: false,
            code: false,
            metadata: false,
            html: false,
            paragraph_text: false,
            list: None,
            task: None,
            in_list: false,
            code_language: None,
            fence: None,
            bodies: Vec::new(),
            underline: None,
        });
    }
    let mut setext = Vec::new();
    let mut prose = super::blocks_paragraph::ProseAttribution::default();
    for (event, range) in events.iter().cloned() {
        prose.observe(&event, &range);
        match event {
            Event::Start(Tag::BlockQuote(_)) => {
                let first = lines.partition_point(|line| line.source.end <= range.start);
                let last = lines.partition_point(|line| line.source.start < range.end);
                for line in &mut lines[first..last] {
                    line.quote_depth += 1;
                    line.quote_start |= range.start >= line.source.start;
                }
            }
            Event::Start(Tag::Heading { level, .. }) => {
                let first = lines
                    .partition_point(|line| line.source.start <= range.start)
                    .saturating_sub(1);
                lines[first].heading = level as u8;
                let raw = source[range.clone()].trim_start_matches([' ', '\t']);
                let hashes = raw.bytes().take_while(|ch| *ch == b'#').count();
                let atx = (1..=6).contains(&hashes)
                    && matches!(
                        raw.as_bytes().get(hashes),
                        None | Some(b' ' | b'\t' | b'\r' | b'\n')
                    );
                lines[first].heading_syntax = if atx {
                    HeadingSyntax::Atx
                } else {
                    HeadingSyntax::Setext
                };
                if !atx {
                    let last = lines
                        .partition_point(|line| line.source.start < range.end)
                        .saturating_sub(1);
                    if last > first {
                        setext.push((first, last));
                    }
                }
            }
            Event::Rule => {
                let at = lines
                    .partition_point(|line| line.source.start <= range.start)
                    .saturating_sub(1);
                lines[at].divider = true;
            }
            Event::Start(Tag::Item) => mark_items(&mut lines, &range),
            Event::Start(Tag::CodeBlock(_)) => {
                let first = lines.partition_point(|line| line.source.end <= range.start);
                let last = lines.partition_point(|line| line.source.start < range.end);
                for line in &mut lines[first..last] {
                    line.code = true;
                }
            }
            Event::Start(Tag::HtmlBlock) => {
                let first = lines.partition_point(|line| line.source.end <= range.start);
                let last = lines.partition_point(|line| line.source.start < range.end);
                for line in &mut lines[first..last] {
                    line.html = true;
                }
            }
            _ => {}
        }
    }
    prose.flush();
    let mut lists = super::lists::describe(source, events);
    let mut prefixes = Vec::new();
    for line in &mut lines {
        let end = line.content.end;
        let attribution = lists.line(line.source.start, end);
        line.task = attribution.task;
        line.list = attribution.list;
        let (prefix, mut column) = container_prefix(
            &source[line.source.start..end],
            line.quote_depth,
            line.list.as_ref(),
        );
        let mut start = line.source.start + prefix;
        if let Some(end) = attribution.prefix_end.filter(|&end| end > start) {
            column = super::columns(&source[start..end], column);
            start = end;
        }
        if line.heading_syntax == HeadingSyntax::Atx {
            let (marker, _) = container_indent(source.as_bytes(), start, end, column);
            let hashes = source[marker..end]
                .bytes()
                .take_while(|b| *b == b'#')
                .count();
            if hashes > 0 {
                start = marker + hashes;
                loop {
                    if start >= end || !matches!(source.as_bytes()[start], b' ' | b'\t') {
                        break;
                    }
                    start += 1;
                }
                let trimmed = source[start..end].trim_end_matches(|ch| matches!(ch, ' ' | '\t'));
                let closing = trimmed.bytes().rev().take_while(|b| *b == b'#').count();
                if closing > 0
                    && (closing == trimmed.len()
                        || trimmed.as_bytes()[trimmed.len() - closing - 1].is_ascii_whitespace())
                {
                    line.content.end = start
                        + trimmed[..trimmed.len() - closing]
                            .trim_end_matches(|ch| matches!(ch, ' ' | '\t'))
                            .len();
                }
            }
        }
        prefixes.push(line.source.start..start);
        line.content.start = start;
        line.paragraph_text =
            line.heading == 0 && !line.code && !line.divider && prose.owns(&line.content);
        line.bodies.push(PhysicalLine {
            source: line.source.clone(),
            content: line.content.clone(),
        });
    }
    // The parser lets a last item own the blank lines that end the note. Only the first of
    // them continues the item (text typed there is lazy); a line after a blank line starts
    // a paragraph, so it is not shown as a list row. A quoted blank line is blank too.
    let trailing = lines.len()
        - lines
            .iter()
            .rev()
            .take_while(|line| {
                source[line.source.clone()]
                    .chars()
                    .all(|ch| ch == '>' || ch.is_whitespace())
            })
            .count();
    for line in lines.iter_mut().skip(trailing + 1) {
        if line.list.as_ref().is_some_and(|list| !list.first) {
            line.list = None;
            line.task = None;
            line.in_list = false;
        }
    }
    for (first, last) in setext.into_iter().rev() {
        lines[first].bodies = lines[first..last]
            .iter()
            .flat_map(|line| line.bodies.iter().cloned())
            .collect();
        lines[first].underline = Some(lines[last].bodies[0].clone());
        let underline = lines[last].source.start;
        lines[first].content.end = source[..underline].trim_end_matches(['\r', '\n']).len();
        lines[first].source.end = lines[last].source.end;
        lines.drain(first + 1..=last);
    }
    fences(source, events, &mut lines);
    (lines, prefixes)
}

/// The canonical quote/list prefix, excluding a block's own indentation.
/// Return its byte end and physical column; opaque body spaces stay outside it.
pub(crate) fn container_prefix(
    source: &str,
    quote_depth: usize,
    list: Option<&super::lists::ListLine>,
) -> (usize, usize) {
    let end = source.len();
    let (mut start, mut column, consumed_quotes) =
        consume_quote_prefix(source.as_bytes(), 0, end, quote_depth, 0);
    if let Some(list) = list {
        if !list.first {
            while start < end && column < list.content_column {
                match source.as_bytes()[start] {
                    b' ' => column += 1,
                    b'\t' => column += 4 - column % 4,
                    _ => break,
                }
                start += 1;
            }
        }
        let remaining = if list.first {
            if list.indent > start {
                column = super::columns(&source[start..list.indent], column);
                start = list.indent;
            }
            // The innermost item owns quotes before its header, including
            // quotes crossed by same-line list syntax.
            quote_depth.saturating_sub(list.quote_depth)
        } else {
            quote_depth.saturating_sub(consumed_quotes)
        };
        let (quote_end, quote_column, _) =
            consume_quote_prefix(source.as_bytes(), start, end, remaining, column);
        start = quote_end;
        column = quote_column;
    }
    (start, column)
}

/// Consume only the parser-attributed quote levels at this container origin.
/// Tabs advance physical four-column stops; indentation is at most three
/// columns relative to each quote's content origin, never three bytes.
fn consume_quote_prefix(
    source: &[u8],
    mut start: usize,
    end: usize,
    depth: usize,
    mut column: usize,
) -> (usize, usize, usize) {
    let mut consumed = 0;
    for _ in 0..depth {
        let (at, at_column) = container_indent(source, start, end, column);
        if at >= end || source[at] != b'>' {
            break;
        }
        start = at + 1;
        column = at_column + 1;
        if start < end && matches!(source[start], b' ' | b'\t') {
            column += if source[start] == b'\t' {
                4 - column % 4
            } else {
                1
            };
            start += 1;
        }
        consumed += 1;
    }
    (start, column, consumed)
}

fn container_indent(source: &[u8], start: usize, end: usize, column: usize) -> (usize, usize) {
    let mut at = start;
    let mut at_column = column;
    loop {
        if at >= end {
            break;
        }
        let next = match source[at] {
            b' ' => at_column + 1,
            b'\t' => at_column + 4 - at_column % 4,
            _ => break,
        };
        if next - column > 3 {
            break;
        }
        at += 1;
        at_column = next;
    }
    (at, at_column)
}

fn mark_item_lines(lines: &mut [BlockLine], range: &Range<usize>) {
    // Physical rows are ordered and nonoverlapping. Keep the old strict
    // overlap predicate, including an empty query inside a nonempty row.
    let first = lines.partition_point(|line| line.source.end <= range.start);
    let last = lines.partition_point(|line| line.source.start < range.end);
    if first < last {
        for line in &mut lines[first..last] {
            line.in_list = true;
        }
    }
}

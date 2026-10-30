//! Block meaning comes from CommonMark events; marker spelling stays in source.
use pulldown_cmark::{Event, Tag};
use std::ops::Range;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum HeadingSyntax {
    None,
    Atx,
    Setext,
}

/// A physical line retains its exact prefix, body and line-ending boundaries.
#[derive(Clone, Debug)]
pub(crate) struct PhysicalLine {
    pub source: Range<usize>,
    pub content: Range<usize>,
}

#[derive(Clone, Debug)]
pub(crate) struct BlockLine {
    pub source: Range<usize>,
    pub content: Range<usize>,
    pub heading: u8,
    pub heading_syntax: HeadingSyntax,
    pub quote_depth: usize,
    pub quote_start: bool,
    pub divider: bool,
    pub code: bool,
    pub empty_comment: bool,
    pub list: Option<super::lists::ListLine>,
    pub task: Option<Range<usize>>,
    pub bodies: Vec<PhysicalLine>,
    pub underline: Option<PhysicalLine>,
}

impl BlockLine {
    pub(crate) fn shift(&mut self, by: usize) {
        for range in [&mut self.source, &mut self.content] {
            range.start += by;
            range.end += by;
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

pub(super) fn describe(
    source: &str,
    events: &[(Event<'_>, Range<usize>)],
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
                empty_comment: false,
                list: None,
                task: None,
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
            empty_comment: false,
            list: None,
            task: None,
            bodies: Vec::new(),
            underline: None,
        });
    }
    let mut setext = Vec::new();
    for (event, range) in events.iter().cloned() {
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
            Event::Start(Tag::CodeBlock(_)) => {
                let first = lines.partition_point(|line| line.source.end <= range.start);
                let last = lines.partition_point(|line| line.source.start < range.end);
                for line in &mut lines[first..last] {
                    line.code = true;
                }
            }
            _ => {}
        }
    }
    let mut lists = super::lists::describe(source, events);
    let comments = super::empty_comments::ranges(events);
    let mut comment = 0;
    let mut prefixes = Vec::new();
    for line in &mut lines {
        let end = line.content.end;
        let mut start = line.source.start;
        for _ in 0..line.quote_depth {
            let spaces = source[start..end]
                .bytes()
                .take_while(|b| *b == b' ')
                .count()
                .min(3);
            if source.as_bytes().get(start + spaces) != Some(&b'>') {
                break;
            }
            start += spaces + 1;
            if matches!(source.as_bytes().get(start), Some(b' ' | b'\t')) {
                start += 1;
            }
        }
        if line.heading_syntax == HeadingSyntax::Atx {
            let spaces = source[start..end]
                .bytes()
                .take_while(|b| *b == b' ')
                .count()
                .min(3);
            let marker = start + spaces;
            let hashes = source[marker..end]
                .bytes()
                .take_while(|b| *b == b'#')
                .count();
            if hashes > 0 {
                start = marker + hashes;
                while start < end && matches!(source.as_bytes()[start], b' ' | b'\t') {
                    start += 1;
                }
                let trimmed = source[start..end].trim_end_matches([' ', '\t']);
                let closing = trimmed.bytes().rev().take_while(|b| *b == b'#').count();
                if closing > 0
                    && (closing == trimmed.len()
                        || trimmed.as_bytes()[trimmed.len() - closing - 1].is_ascii_whitespace())
                {
                    line.content.end = start
                        + trimmed[..trimmed.len() - closing]
                            .trim_end_matches([' ', '\t'])
                            .len();
                }
            }
        }
        let attribution = lists.line(line.source.start, end);
        line.task = attribution.task;
        line.list = attribution.list;
        if let Some(list) = &line.list {
            if !list.first {
                let mut column = start - line.source.start;
                while start < end && column < list.indent {
                    match source.as_bytes()[start] {
                        b' ' => column += 1,
                        b'\t' => column += 4 - column % 4,
                        _ => break,
                    }
                    start += 1;
                }
            }
        }
        if let Some(end) = attribution.prefix_end {
            start = start.max(end);
        }
        while comments
            .get(comment)
            .is_some_and(|range| range.end <= line.source.start)
        {
            comment += 1;
        }
        line.empty_comment = !line.code
            && line.list.is_none()
            && comments.get(comment).is_some_and(|range| {
                line.source.start <= range.start && range.end <= line.source.end
            });
        prefixes.push(line.source.start..start);
        line.content.start = start;
        line.bodies.push(PhysicalLine {
            source: line.source.clone(),
            content: line.content.clone(),
        });
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
    (lines, prefixes)
}

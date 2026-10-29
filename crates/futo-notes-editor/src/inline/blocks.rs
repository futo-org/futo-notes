//! Block meaning comes from CommonMark events; marker spelling stays in source.
use pulldown_cmark::{Event, Tag};
use std::ops::Range;

#[derive(Clone, Debug)]
pub(crate) struct BlockLine {
    pub source: Range<usize>,
    pub content: Range<usize>,
    pub heading: u8,
    pub quote_depth: usize,
    pub quote_start: bool,
    pub divider: bool,
    pub code: bool,
}

pub(super) fn describe(source: &str, events: &[(Event<'_>, Range<usize>)]) -> Vec<BlockLine> {
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
                quote_depth: 0,
                quote_start: false,
                divider: false,
                code: false,
            }
        })
        .collect();
    if lines.is_empty() || source.ends_with('\n') {
        lines.push(BlockLine {
            source: at..at,
            content: at..at,
            heading: 0,
            quote_depth: 0,
            quote_start: false,
            divider: false,
            code: false,
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
                if !source[range.clone()].trim_start().starts_with('#') {
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
    for (first, last) in setext.into_iter().rev() {
        let underline = lines[last].source.start;
        lines[first].content.end = source[..underline].trim_end_matches(['\r', '\n']).len();
        lines[first].source.end = lines[last].source.end;
        lines.drain(first + 1..=last);
    }
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
        if line.heading > 0 {
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
        line.content.start = start;
    }
    lines
}

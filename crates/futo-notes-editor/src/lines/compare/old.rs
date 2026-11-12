//! What pulldown-cmark, as the engine reads today, makes of each line.
use super::*;
use pulldown_cmark::{CodeBlockKind, Event, LinkType, Options, Parser, Tag, TagEnd};

#[derive(Clone, Debug, Default)]
pub(super) struct Old {
    pub(super) quote: usize,
    pub(super) lists: usize,
    pub(super) item_start: bool,
    pub(super) number: Option<u64>,
    pub(super) heading: Option<u8>,
    pub(super) setext_text: bool,
    pub(super) setext_underline: bool,
    pub(super) fenced: bool,
    pub(super) fence_edge: bool,
    pub(super) fence_open: bool,
    pub(super) indented_code: bool,
    pub(super) html: bool,
    pub(super) table: Option<TableRole>,
    pub(super) paragraph: bool,
    pub(super) continuation: bool,
    pub(super) rule: bool,
    pub(super) footnote: bool,
    pub(super) metadata: bool,
    pub(super) covered: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Shape {
    Blank,
    Plain,
    Heading(u8),
    List(usize),
    Divider,
    Code,
    Fence,
    FrontMatter,
    Table(TableRole),
    Html,
    Hidden,
}

pub(super) fn line_starts(source: &str) -> Vec<usize> {
    let mut starts = vec![0];
    starts.extend(source.match_indices('\n').map(|(at, _)| at + 1));
    starts
}

pub(super) fn line_of(starts: &[usize], offset: usize) -> usize {
    starts.partition_point(|&start| start <= offset) - 1
}

/// What pulldown-cmark makes of each line (front matter by the engine's own
/// rule, as `Projection` reads it).
pub(super) fn old_lines(source: &str) -> (Vec<Old>, Vec<(OldSpan, usize, usize)>) {
    let starts = line_starts(source);
    let mut lines = vec![Old::default(); starts.len()];
    let metadata = crate::inline::front_matter::len(source.bytes());
    if metadata > 0 {
        for line in &mut lines[..=line_of(&starts, metadata - 1)] {
            line.metadata = true;
            line.covered = true;
        }
    }
    let body = &source[metadata..];
    let options = crate::inline::parser_options() | Options::ENABLE_TABLES;
    let mut spans = Vec::new();
    let mut numbers: Vec<(Option<u64>, u64)> = Vec::new();
    for (event, range) in Parser::new_ext(body, options).into_offset_iter() {
        let mut range = range.start + metadata..range.end + metadata;
        // pulldown-cmark reports a tab-indented item from the line ending
        // before it (`item_line_start` in the engine corrects the same).
        if matches!(
            event,
            Event::Start(Tag::List(_) | Tag::Item) | Event::End(TagEnd::List(_) | TagEnd::Item)
        ) {
            let skip = match source.as_bytes().get(range.start) {
                Some(b'\n') => 1,
                Some(b'\r') if source.as_bytes().get(range.start + 1) == Some(&b'\n') => 2,
                _ => 0,
            };
            if range.start + skip < range.end {
                range.start += skip;
            }
        }
        if range.is_empty() {
            continue;
        }
        let first = line_of(&starts, range.start);
        let last = line_of(&starts, range.end - 1);
        match event {
            Event::Start(Tag::BlockQuote(_)) => each(&mut lines, first, last, |l| l.quote += 1),
            Event::Start(Tag::List(start)) => {
                numbers.push((start, 0));
                each(&mut lines, first, last, |l| l.lists += 1);
            }
            Event::End(TagEnd::List(_)) => {
                numbers.pop();
            }
            Event::Start(Tag::Item) => {
                lines[first].item_start = true;
                if let Some((Some(start), index)) = numbers.last_mut() {
                    lines[first].number = Some(*start + *index);
                    *index += 1;
                }
                each(&mut lines, first, last, |_| {});
            }
            Event::Start(Tag::Heading { level, .. }) => {
                lines[first].heading = Some(level as u8);
                if last > first {
                    lines[first].setext_text = true;
                    for line in &mut lines[first + 1..last] {
                        line.setext_text = true;
                    }
                    lines[last].setext_underline = true;
                }
                each(&mut lines, first, last, |_| {});
            }
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(_))) => {
                each(&mut lines, first, last, |l| l.fenced = true);
                lines[first].fence_edge = true;
                lines[first].fence_open = true;
                let text = source[starts[last]..].lines().next().unwrap_or("").trim();
                if last > first
                    && text.len() >= 3
                    && (text.bytes().all(|b| b == b'`') || text.bytes().all(|b| b == b'~'))
                {
                    lines[last].fence_edge = true;
                }
            }
            Event::Start(Tag::CodeBlock(CodeBlockKind::Indented)) => {
                each(&mut lines, first, last, |l| l.indented_code = true)
            }
            Event::Start(Tag::HtmlBlock) => each(&mut lines, first, last, |l| l.html = true),
            Event::Start(Tag::Table(_)) => each(&mut lines, first, last, |l| {
                l.table.get_or_insert(TableRole::Delimiter);
            }),
            Event::Start(Tag::TableHead) => each(&mut lines, first, last, |l| {
                l.table = Some(TableRole::Header)
            }),
            Event::Start(Tag::TableRow) => {
                each(&mut lines, first, last, |l| l.table = Some(TableRole::Row))
            }
            Event::Start(Tag::Paragraph) => {
                each(&mut lines, first, last, |l| l.paragraph = true);
                for line in &mut lines[first + 1..=last] {
                    line.continuation = true;
                }
            }
            Event::Rule => each(&mut lines, first, last, |l| l.rule = true),
            Event::Start(Tag::FootnoteDefinition(_)) => {
                each(&mut lines, first, last, |l| l.footnote = true)
            }
            Event::Start(Tag::Strong) => spans.push((OldSpan::Bold, range.start, range.end)),
            Event::Start(Tag::Emphasis) => spans.push((OldSpan::Italic, range.start, range.end)),
            Event::Start(Tag::Strikethrough) => {
                spans.push((OldSpan::Strike, range.start, range.end))
            }
            Event::Code(_) => spans.push((OldSpan::Code, range.start, range.end)),
            Event::Start(Tag::Link { link_type, .. }) => {
                let kind = match link_type {
                    LinkType::Autolink | LinkType::Email => OldSpan::Angle,
                    LinkType::Inline => OldSpan::Link,
                    _ => OldSpan::Reference,
                };
                spans.push((kind, range.start, range.end));
            }
            Event::Start(Tag::Image { link_type, .. }) => {
                let kind = if link_type == LinkType::Inline {
                    OldSpan::Image
                } else {
                    OldSpan::Reference
                };
                spans.push((kind, range.start, range.end));
            }
            _ => {}
        }
    }
    (lines, spans)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum OldSpan {
    Bold,
    Italic,
    Strike,
    Code,
    Link,
    Image,
    Angle,
    Reference,
}

pub(super) fn each(lines: &mut [Old], first: usize, last: usize, mut f: impl FnMut(&mut Old)) {
    for line in &mut lines[first..=last] {
        line.covered = true;
        f(line);
    }
}

pub(super) fn old_shape(old: &Old, text: &str) -> Shape {
    if old.metadata {
        Shape::FrontMatter
    } else if old.fenced {
        if old.fence_edge {
            Shape::Fence
        } else {
            Shape::Code
        }
    } else if old.indented_code {
        Shape::Code
    } else if old.html {
        Shape::Html
    } else if let Some(role) = old.table {
        Shape::Table(role)
    } else if old.setext_underline {
        Shape::Heading(0)
    } else if old.item_start {
        Shape::List(0)
    } else if let Some(level) = old.heading {
        Shape::Heading(level)
    } else if old.rule {
        Shape::Divider
    } else if text.trim().trim_start_matches(['>', ' ', '\t']).is_empty()
        && (old.quote > 0 || text.trim().is_empty())
    {
        Shape::Blank
    } else if !old.covered {
        Shape::Hidden
    } else {
        Shape::Plain
    }
}

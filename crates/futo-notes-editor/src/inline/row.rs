use crate::InlineFormat;
use pulldown_cmark::{Event, Options, Parser, Tag};
use std::ops::Range;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SpanKind {
    Format(InlineFormat),
    Link(String),
}

impl SpanKind {
    pub fn format(&self) -> Option<InlineFormat> {
        match self {
            Self::Format(format) => Some(*format),
            Self::Link(_) => None,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Span {
    pub kind: SpanKind,
    pub open: Range<usize>,
    pub close: Range<usize>,
}

#[derive(Clone, Debug)]
pub(crate) struct Segment {
    pub source: Range<usize>,
    pub display: Range<usize>,
    // Only literal source runs permit arithmetic mapping within the segment.
    // A decoded entity can have the same UTF-8 length as its source spelling.
    pub identity: bool,
}

pub(crate) struct Row {
    pub source_len: usize,
    pub parsed_source_bytes: usize,
    pub display: String,
    pub segments: Vec<Segment>,
    pub spans: Vec<Span>,
    pub blocks: Vec<super::blocks::BlockLine>,
}

impl Row {
    pub fn parse(source: &str) -> Self {
        let events: Vec<_> = Parser::new_ext(source, Options::ENABLE_STRIKETHROUGH)
            .into_offset_iter()
            .collect();
        let (blocks, prefixes) = super::blocks::describe(source, &events);
        let mut hidden = vec![false; source.len()];
        for prefix in prefixes {
            hidden[prefix].fill(true);
        }
        let mut spans = Vec::new();
        let mut replacements = Vec::<(Range<usize>, String)>::new();
        let mut in_code = false;
        let mut link = None;
        for (event, range) in events {
            match &event {
                Event::Start(Tag::CodeBlock(_)) => {
                    in_code = true;
                    continue;
                }
                Event::End(pulldown_cmark::TagEnd::CodeBlock) => {
                    in_code = false;
                    continue;
                }
                _ if in_code => continue,
                _ => {}
            }
            match &event {
                Event::Start(Tag::Link { dest_url, .. }) => {
                    link = Some((range.clone(), dest_url.to_string(), range.start + 1));
                }
                Event::End(pulldown_cmark::TagEnd::Link) => {
                    if let Some((whole, destination, label_end)) = link.take() {
                        let label = whole.start + 1..label_end;
                        let span = Span {
                            kind: SpanKind::Link(destination),
                            open: whole.start..label.start,
                            close: label.end..whole.end,
                        };
                        hidden[span.open.clone()].fill(true);
                        hidden[span.close.clone()].fill(true);
                        spans.push(span);
                    }
                }
                _ => {
                    if let Some((_, _, label_end)) = &mut link {
                        *label_end = (*label_end).max(range.end);
                    }
                }
            }
            let format = match event {
                Event::Start(Tag::Strong) => Some((InlineFormat::Bold, 2)),
                Event::Start(Tag::Emphasis) => Some((InlineFormat::Italic, 1)),
                Event::Start(Tag::Strikethrough) => {
                    let width = if source[range.clone()].starts_with("~~") {
                        2
                    } else {
                        1
                    };
                    Some((InlineFormat::Strike, width))
                }
                Event::Code(_) => {
                    let (span, code_replacements) = code_span(source, range.clone());
                    hidden[span.open.clone()].fill(true);
                    hidden[span.close.clone()].fill(true);
                    spans.push(span);
                    replacements.extend(code_replacements);
                    None
                }
                Event::Text(text) => {
                    if text.as_ref() != &source[range.clone()] {
                        replacements.push((range.clone(), text.into_string()));
                    } else if range.start > 0 && source.as_bytes()[range.start - 1] == b'\\' {
                        if let Some(first) = text.chars().next().filter(char::is_ascii_punctuation)
                        {
                            replacements.push((
                                range.start - 1..range.start + first.len_utf8(),
                                first.to_string(),
                            ));
                        }
                    }
                    None
                }
                _ => None,
            };
            if let Some((format, width)) = format {
                let open = range.start..range.start + width;
                let close = range.end - width..range.end;
                hidden[open.clone()].fill(true);
                hidden[close.clone()].fill(true);
                spans.push(Span {
                    kind: SpanKind::Format(format),
                    open,
                    close,
                });
            }
        }
        for block in &blocks {
            if let Some(fence) = &block.fence {
                hidden[fence.separator.clone()].fill(true);
            }
            hidden[block.source.start..block.content.start].fill(true);
            let end = source[block.source.clone()]
                .trim_end_matches(['\r', '\n'])
                .len()
                + block.source.start;
            if block.content.end <= end {
                hidden[block.content.end..end].fill(true);
            }
            if block.divider {
                replacements.push((block.content.clone(), "\u{fffc}".into()));
            }
        }
        replacements.sort_by_key(|(r, _)| r.start);
        let mut replacements = replacements.into_iter().peekable();
        let mut display = String::new();
        let mut segments = Vec::new();
        let mut at = 0;
        while at < source.len() {
            let start = at;
            let display_start = display.len();
            if let Some((range, _)) = replacements.peek() {
                if range.start == at {
                    let (range, text) = replacements.next().unwrap();
                    display.push_str(&text);
                    at = range.end;
                    segments.push(Segment {
                        source: start..at,
                        display: display_start..display.len(),
                        identity: false,
                    });
                    continue;
                }
            }
            if hidden[at] {
                at += source[at..].chars().next().unwrap().len_utf8();
            } else {
                at += source[at..].chars().next().unwrap().len_utf8();
                display.push_str(&source[start..at]);
            }
            segments.push(Segment {
                source: start..at,
                display: display_start..display.len(),
                identity: !hidden[start],
            });
        }
        let (bare, additional_parse) = super::links::bare_links(source);
        spans.extend(bare);
        spans.sort_by_key(|span| (span.open.start, std::cmp::Reverse(span.close.end)));
        Self {
            source_len: source.len(),
            parsed_source_bytes: source.len() + additional_parse,
            display,
            segments,
            spans,
            blocks,
        }
    }

    pub fn source_bounds(&self, at: usize) -> (usize, usize) {
        let mut low = self.source_len;
        let mut high = 0;
        for segment in &self.segments {
            if segment.display.start <= at && at <= segment.display.end {
                let (a, b) = if segment.display.is_empty() {
                    (segment.source.start, segment.source.end)
                } else if at == segment.display.start {
                    (segment.source.start, segment.source.start)
                } else if at == segment.display.end {
                    (segment.source.end, segment.source.end)
                } else {
                    if segment.identity {
                        let position = segment.source.start + at - segment.display.start;
                        (position, position)
                    } else {
                        (segment.source.start, segment.source.end)
                    }
                };
                low = low.min(a);
                high = high.max(b);
            }
        }
        if self.segments.is_empty() {
            (0, 0)
        } else {
            (low, high)
        }
    }

    pub fn display_at(&self, source: usize) -> usize {
        for segment in &self.segments {
            if segment.source.start <= source && source <= segment.source.end {
                if segment.identity {
                    return segment.display.start + source - segment.source.start;
                }
                return if source == segment.source.end {
                    segment.display.end
                } else {
                    segment.display.start
                };
            }
        }
        self.display.len()
    }

    pub fn formats_at(&self, source: usize) -> Vec<InlineFormat> {
        self.spans
            .iter()
            .filter(|span| span.open.end <= source && source <= span.close.start)
            .filter_map(|span| span.kind.format())
            .collect()
    }
}

/// Blank lines bound independent inline parses. Keep each separator with its
/// preceding paragraph; edits reparse neighboring paragraphs when joining.
pub(crate) fn paragraphs(source: &str) -> Vec<&str> {
    let protected: Vec<_> = Parser::new(source)
        .into_offset_iter()
        .filter_map(|(event, range)| match event {
            Event::Start(Tag::CodeBlock(_)) => Some(range),
            _ => None,
        })
        .collect();
    let mut protected_index = 0;
    let mut result = Vec::new();
    let mut start = 0;
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        while protected_index < protected.len() && protected[protected_index].end <= line_start {
            protected_index += 1;
        }
        let in_code = protected
            .get(protected_index)
            .is_some_and(|range| range.start <= line_start && line_start < range.end);
        if !in_code && line.trim_matches([' ', '\t', '\r', '\n']).is_empty() {
            result.push(&source[start..offset]);
            start = offset;
        }
    }
    if start < source.len() || result.is_empty() {
        result.push(&source[start..]);
    }
    result
}

fn code_span(source: &str, range: Range<usize>) -> (Span, Vec<(Range<usize>, String)>) {
    let raw = &source[range.clone()];
    let width = raw.bytes().take_while(|b| *b == b'`').count();
    let mut start = range.start + width;
    let mut end = range.end - width;
    let normalized = source[start..end]
        .replace("\r\n", " ")
        .replace(['\r', '\n'], " ");
    if normalized.starts_with(' ')
        && normalized.ends_with(' ')
        && normalized.chars().any(|c| c != ' ')
    {
        start += if source[start..end].starts_with("\r\n") {
            2
        } else {
            1
        };
        end -= if source[start..end].ends_with("\r\n") {
            2
        } else {
            1
        };
    }
    let span = Span {
        kind: SpanKind::Format(InlineFormat::Code),
        open: range.start..start,
        close: end..range.end,
    };
    let mut replacements = Vec::new();
    let mut at = start;
    while at < end {
        let ch = source[at..end].chars().next().unwrap();
        if ch == '\r' || ch == '\n' {
            let width = if source[at..end].starts_with("\r\n") {
                2
            } else {
                1
            };
            replacements.push((at..at + width, " ".into()));
            at += width;
        } else {
            at += ch.len_utf8();
        }
    }
    (span, replacements)
}

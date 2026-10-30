mod parse;
use crate::InlineFormat;
use pulldown_cmark::{Event, Parser, Tag};
use std::ops::Range;
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SpanKind {
    Format(InlineFormat),
    Link(Arc<LinkMeaning>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LinkMeaning {
    pub destination: String,
    pub title: Option<String>,
    pub reference: Option<Arc<str>>,
}

impl LinkMeaning {
    pub fn bare(destination: String) -> Arc<Self> {
        Arc::new(Self {
            destination,
            title: None,
            reference: None,
        })
    }
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

/// Consecutive transparent physical blanks share a context run. All other
/// blocks are individual witnesses, including code and quote boundaries.
pub(super) struct ContextRun {
    pub source: Range<usize>,
    pub first: usize,
    pub last: usize,
    pub transparent_quote: Option<usize>,
}

pub(crate) struct Row {
    pub source_len: usize,
    pub parsed_source_bytes: usize,
    pub literal_delimiters: Vec<Range<usize>>,
    pub literal_links: Vec<Range<usize>>,
    pub definitions: Vec<super::references::Definition>,
    pub reference_uses: Vec<super::references::ReferenceUse>,
    pub reference_work: super::references::ReferenceWork,
    pub display: String,
    pub segments: Vec<Segment>,
    pub spans: Vec<Span>,
    pub blocks: Vec<super::blocks::BlockLine>,
    pub(super) context: Vec<ContextRun>,
    pub(super) transparent_quote: Option<usize>,
}

impl Row {
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
            Event::Start(Tag::CodeBlock(_) | Tag::List(_)) => Some(range),
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

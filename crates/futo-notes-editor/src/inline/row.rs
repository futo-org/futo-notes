mod html;
mod parse;
pub(crate) use html::CandidateOpener;
mod split;
use crate::InlineFormat;
use pulldown_cmark::{Event, Options, Parser, Tag};
#[cfg(test)]
pub(crate) use split::UNCUT;
pub(crate) use split::{partition, Outside};
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
    pub guarded_words: Vec<super::guarded_words::GuardedWord>,
    pub images: Vec<super::images::RowImage>,
    pub wikilinks: Vec<super::wikilinks::RowWikilink>,
    pub wikilink_mask: u64,
    /// Code and HTML source ranges; kept only for rows containing `[[`.
    pub wikilink_isolated: Vec<Range<usize>>,
    pub typed_inputs: Vec<super::typed_angle::TypedAngleOrigin>,
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
    /// This row's first block continues the preceding row's last block.
    pub continues: bool,
    /// This row continues one block that the following row continues too.
    pub through: bool,
    /// The document's leading front matter row (always row zero).
    pub metadata: bool,
    /// The opener line of the raw HTML block this row continues (#314).
    pub opener: Option<Arc<str>>,
}

pub(super) fn parser_options() -> Options {
    // GFM footnotes keep `[^x]` and its definition visible literal source
    // rather than a hidden CommonMark reference definition.
    Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_FOOTNOTES
}
pub(super) fn source_events(source: &str) -> Vec<(Event<'_>, Range<usize>)> {
    Parser::new_ext(source, parser_options())
        .into_offset_iter()
        .collect()
}

impl Row {
    pub fn source_bounds(&self, at: usize) -> (usize, usize) {
        self.source_bounds_with_work(at).0
    }
    pub fn source_bounds_with_work(&self, at: usize) -> ((usize, usize), usize) {
        if self.segments.is_empty() {
            return ((0, 0), 0);
        }
        let mut examined = 0;
        let first = self.segments.partition_point(|segment| {
            examined += 1;
            segment.display.end < at
        });
        #[cfg(test)]
        let first_work = examined;
        let last = self.segments.partition_point(|segment| {
            examined += 1;
            segment.display.start <= at
        });
        // Row construction advances both cursors monotonically without overlap.
        // Thus the first/last inclusive matches own the complete union extrema,
        // including every intervening hidden zero-display segment.
        let result = if first < last {
            let begin = &self.segments[first];
            let end = &self.segments[last - 1];
            examined += 2;
            if begin.display.start <= at
                && at <= begin.display.end
                && end.display.start <= at
                && at <= end.display.end
            {
                let bounds = |segment: &Segment| {
                    if segment.display.is_empty() {
                        (segment.source.start, segment.source.end)
                    } else if at == segment.display.start {
                        (segment.source.start, segment.source.start)
                    } else if at == segment.display.end {
                        (segment.source.end, segment.source.end)
                    } else if segment.identity {
                        let position = segment.source.start + at - segment.display.start;
                        (position, position)
                    } else {
                        (segment.source.start, segment.source.end)
                    }
                };
                Some((bounds(begin).0, bounds(end).1))
            } else {
                None
            }
        } else {
            None
        };
        #[cfg(test)]
        super::coordinate_work_tests::bounds(
            examined,
            first_work + last.saturating_sub(first) + usize::from(last < self.segments.len()),
        );
        super::visit_correspondence(examined);
        (result.unwrap_or((self.source_len, 0)), examined)
    }

    pub fn source_point_with_work(
        &self,
        at: usize,
        affinity: crate::Affinity,
    ) -> (crate::history::SourcePoint, usize) {
        let mut work = 0;
        let first = self.segments.partition_point(|segment| {
            work += 1;
            segment.display.end < at
        });
        if let Some(segment) = self.segments.get(first) {
            work += 1;
            if !segment.identity && segment.display.start < at && at < segment.display.end {
                super::visit_correspondence(work);
                return (
                    crate::history::SourcePoint {
                        source: crate::SourceOffset(segment.source.start),
                        within: at - segment.display.start,
                        atom: Some(crate::history::SourceAtom {
                            source_len: segment.source.len(),
                            display_len: segment.display.len(),
                        }),
                    },
                    work,
                );
            }
        }
        super::visit_correspondence(work);
        let ((low, high), visits) = self.source_bounds_with_work(at);
        (
            crate::history::SourcePoint {
                source: crate::SourceOffset(if affinity == crate::Affinity::Forward {
                    high
                } else {
                    low
                }),
                within: 0,
                atom: None,
            },
            work + visits,
        )
    }

    pub fn project_source_point(&self, point: crate::history::SourcePoint) -> (usize, usize) {
        let (display, work) = self.try_project_source_point(point);
        (
            display.expect("exact history restores its own parser-owned source atom"),
            work,
        )
    }

    pub fn try_project_source_point(
        &self,
        point: crate::history::SourcePoint,
    ) -> (Option<usize>, usize) {
        if point.source.0 > self.source_len {
            super::visit_correspondence(1);
            return (None, 1);
        }
        let Some(atom) = point.atom else {
            let mut work = 0;
            let index = self.segments.partition_point(|segment| {
                work += 1;
                segment.source.end < point.source.0
            });
            let Some(segment) = self.segments.get(index) else {
                super::visit_correspondence(work);
                return (Some(self.display.len()), work);
            };
            work += 1;
            if !segment.identity
                && segment.source.start < point.source.0
                && point.source.0 < segment.source.end
            {
                super::visit_correspondence(work);
                return (None, work);
            }
            let display = if segment.identity {
                segment.display.start + point.source.0 - segment.source.start
            } else if point.source.0 == segment.source.end {
                segment.display.end
            } else {
                segment.display.start
            };
            work += 1;
            super::visit_correspondence(work);
            return (
                self.display.is_char_boundary(display).then_some(display),
                work,
            );
        };
        let mut work = 0;
        let index = self.segments.partition_point(|segment| {
            work += 1;
            segment.source.start < point.source.0
        });
        let Some(segment) = self.segments.get(index) else {
            super::visit_correspondence(work);
            return (None, work);
        };
        work += 1;
        let valid = !segment.identity
            && segment.source.start == point.source.0
            && segment.source.len() == atom.source_len
            && segment.display.len() == atom.display_len
            && point.within < atom.display_len
            && self.display[segment.display.clone()].is_char_boundary(point.within);
        super::visit_correspondence(work);
        (valid.then_some(segment.display.start + point.within), work)
    }

    pub fn display_at(&self, source: usize) -> usize {
        self.display_at_with_work(source).0
    }

    pub fn display_at_with_work(&self, source: usize) -> (usize, usize) {
        let mut work = 0;
        let index = self.segments.partition_point(|segment| {
            work += 1;
            segment.source.end < source
        });
        let segment = self.segments.get(index).filter(|segment| {
            work += 1;
            segment.source.start <= source && source <= segment.source.end
        });
        super::visit_correspondence(work);
        if let Some(segment) = segment {
            let display = if segment.identity {
                segment.display.start + source - segment.source.start
            } else if source == segment.source.end {
                segment.display.end
            } else {
                segment.display.start
            };
            (display, work)
        } else {
            (self.display.len(), work)
        }
    }

    pub fn formats_at(&self, source: usize) -> Vec<InlineFormat> {
        self.spans
            .iter()
            .filter(|span| span.open.end <= source && source <= span.close.start)
            .filter_map(|span| span.kind.format())
            .collect()
    }
}

pub(crate) enum OpenEnd {
    Html,
    Footnote,
}

/// A raw HTML block (CommonMark kinds 1-5 run to their end condition across
/// blank lines) or footnote definition that owns the window's trailing blank
/// line may continue past it. Window rows always end after a blank line.
/// Returns the parsed byte count with the answer.
pub(crate) fn open_at_end(source: &str) -> (Option<OpenEnd>, usize) {
    if !source.ends_with('\n') || !(source.contains('<') || source.contains("[^")) {
        return (None, 0);
    }
    let mut open = None;
    for (event, range) in Parser::new_ext(source, parser_options()).into_offset_iter() {
        if range.end == source.len() {
            match event {
                Event::Start(Tag::HtmlBlock) => open = Some(OpenEnd::Html),
                Event::Start(Tag::FootnoteDefinition(_)) => open = open.or(Some(OpenEnd::Footnote)),
                _ => {}
            }
        }
    }
    (open, source.len())
}

/// The opener line of a raw HTML block still open at the end of `source`.
pub(crate) fn html_tail(source: &str) -> Option<&str> {
    let mut open = None;
    for (event, range) in Parser::new_ext(source, parser_options()).into_offset_iter() {
        if matches!(event, Event::Start(Tag::HtmlBlock)) {
            open = (range.end == source.len() && source.ends_with('\n')).then_some(range.start);
        }
    }
    let start = open?;
    let line = source[start..]
        .find('\n')
        .map_or(source.len(), |end| start + end + 1);
    Some(&source[start..line])
}

#[cfg(test)]
#[path = "row_coordinates_tests.rs"]
mod coordinates_tests;

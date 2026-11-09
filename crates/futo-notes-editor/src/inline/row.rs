mod context;
mod html;
mod parse;
pub(crate) use html::{CandidateOpener, Shape};
mod split;
use crate::InlineFormat;
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag};
pub(crate) use split::{delimiter_neutral, list_marker, partition, Outside, WORD_TAIL};
#[cfg(test)]
pub(crate) use split::{NO_WORD_SEAMS, UNCUT};
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

pub(crate) struct Row {
    /// Immutable source facts; metadata-only updates never rewrite them.
    pub(super) table_scan: crate::table::RowScan,
    pub source_len: usize,
    /// The source holds a `|`, as every table header line does.
    pub pipes: bool,
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
    /// This row's first block continues the preceding row's last block.
    pub continues: bool,
    /// This row continues one block that the following row continues too.
    pub through: bool,
    /// This row starts inside its predecessor's last physical line, at a
    /// word seam (#314): the two rows' boundary blocks are one line.
    pub mid_line: bool,
    /// The document's leading front matter row (always row zero).
    pub metadata: bool,
    /// The opener line of the raw HTML block this row continues (#314).
    pub opener: Option<Arc<str>>,
    /// The synthetic ancestor item lines a row cut inside a nested list is
    /// parsed after: its first item continues a list at that depth.
    pub context: Option<Arc<str>>,
    /// For each context ancestor (depth 1 first): the row-relative end of
    /// its item and of the list holding it.
    pub context_ends: Vec<(usize, usize)>,
    /// For each item open at the row's end (depth 1 first): the
    /// row-relative start of the item and of the list holding it.
    pub tail_chain: Vec<(usize, usize)>,
}

pub(crate) fn parser_options() -> Options {
    // GFM footnotes keep `[^x]` and its definition visible literal source
    // rather than a hidden CommonMark reference definition.
    Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_FOOTNOTES
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
            return (None, 1);
        }
        let Some(atom) = point.atom else {
            let mut work = 0;
            let index = self.segments.partition_point(|segment| {
                work += 1;
                segment.source.end < point.source.0
            });
            let Some(segment) = self.segments.get(index) else {
                return (Some(self.display.len()), work);
            };
            work += 1;
            if !segment.identity
                && segment.source.start < point.source.0
                && point.source.0 < segment.source.end
            {
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
            return (None, work);
        };
        work += 1;
        let valid = !segment.identity
            && segment.source.start == point.source.0
            && segment.source.len() == atom.source_len
            && segment.display.len() == atom.display_len
            && point.within < atom.display_len
            && self.display[segment.display.clone()].is_char_boundary(point.within);
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

/// `Row::formats_at` for a run of non-decreasing offsets in one pass: spans
/// enter once their opener ends and leave once their closer starts before the
/// offset, so a row's segments cost spans + segments rather than their product.
pub(crate) struct FormatSweep<'a> {
    row: &'a Row,
    order: Vec<usize>,
    next: usize,
    active: Vec<usize>,
    last: usize,
}

impl<'a> FormatSweep<'a> {
    pub fn new(row: &'a Row) -> Self {
        let mut order: Vec<usize> = (0..row.spans.len())
            .filter(|&index| row.spans[index].kind.format().is_some())
            .collect();
        order.sort_by_key(|&index| row.spans[index].open.end);
        Self {
            row,
            order,
            next: 0,
            active: Vec::new(),
            last: 0,
        }
    }

    /// `work` counts each span entered and each active span checked (a scan
    /// counts every span).
    pub fn formats_at(&mut self, source: usize, work: &mut usize) -> Vec<InlineFormat> {
        if source < self.last {
            *work += self.row.spans.len();
            return self.row.formats_at(source);
        }
        self.last = source;
        let spans = &self.row.spans;
        while let Some(&index) = self.order.get(self.next) {
            if spans[index].open.end > source {
                break;
            }
            self.active.push(index);
            self.next += 1;
            *work += 1;
        }
        *work += self.active.len();
        self.active
            .retain(|&index| source <= spans[index].close.start);
        let mut active = self.active.clone();
        active.sort_unstable();
        active
            .into_iter()
            .filter_map(|index| spans[index].kind.format())
            .collect()
    }
}

pub(crate) enum OpenEnd {
    Html,
    Footnote,
    /// A top-level fence without its closer runs to the end of the note.
    Code,
}

/// A raw HTML block (CommonMark kinds 1-5 run to their end condition across
/// blank lines), unclosed top-level fence or footnote definition that owns the
/// window's trailing blank line may continue past it. Window rows always end
/// after a blank line. Returns the parsed byte count with the answer.
pub(crate) fn open_at_end(source: &str) -> (Option<OpenEnd>, usize) {
    match scan_open(source) {
        Some((open, _)) => (open, source.len()),
        None => (None, 0),
    }
}

/// The opener line of a raw HTML block, or of a top-level fence without its
/// closer, still open at the end of `source`.
pub(crate) fn open_tail(source: &str) -> Option<&str> {
    let start = scan_open(source)?.1?;
    Some(opener_line(source, start))
}

/// What stays open at the end of `source`, and where a raw HTML block or
/// top-level fence open there starts; `None` when nothing can be open.
fn scan_open(source: &str) -> Option<(Option<OpenEnd>, Option<usize>)> {
    let fence = source.contains("```") || source.contains("~~~");
    if !source.ends_with('\n') || !(fence || source.contains('<') || source.contains("[^")) {
        return None;
    }
    let (mut open, mut start, mut depth) = (None, None, 0usize);
    for (event, range) in Parser::new_ext(source, parser_options()).into_offset_iter() {
        if range.end == source.len() {
            match event {
                Event::Start(Tag::HtmlBlock) => {
                    (open, start) = (Some(OpenEnd::Html), Some(range.start))
                }
                Event::Start(Tag::FootnoteDefinition(_)) => open = open.or(Some(OpenEnd::Footnote)),
                Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(_)))
                    if unclosed_fence(&source[range.clone()]) =>
                {
                    open = Some(OpenEnd::Code);
                    start = (depth == 0).then_some(range.start);
                }
                _ => {}
            }
        }
        match event {
            Event::Start(_) => depth += 1,
            Event::End(_) => depth -= 1,
            _ => {}
        }
    }
    Some((open, start))
}

/// The line starting at `start`.
pub(crate) fn opener_line(source: &str, start: usize) -> &str {
    let line = source[start..]
        .find('\n')
        .map_or(source.len(), |end| start + end + 1);
    &source[start..line]
}

/// Whether the last top-level block of `source` continues into `line`.
pub(crate) fn reaches_into(source: &str, line: &str) -> bool {
    let joined = format!("{source}{line}");
    let mut depth = 0usize;
    let mut reaches = false;
    for (event, range) in Parser::new_ext(&joined, parser_options()).into_offset_iter() {
        match event {
            Event::Start(_) => {
                if depth == 0 {
                    reaches = range.start < source.len() && range.end > source.len();
                }
                depth += 1;
            }
            Event::End(_) => depth -= 1,
            _ => {}
        }
    }
    reaches
}

/// Whether a top-level fenced block's source lacks its closing fence. A fence
/// inside a container ends with that container, so it never counts.
pub(crate) fn unclosed_fence(block: &str) -> bool {
    fn fence(line: &str) -> Option<(char, usize, &str)> {
        let body = line.trim_start_matches(' ');
        let marker = body.chars().next().filter(|c| *c == '`' || *c == '~')?;
        let run = body.len() - body.trim_start_matches(marker).len();
        (line.len() - body.len() <= 3 && run >= 3).then_some((marker, run, &body[run..]))
    }
    let mut lines = block.lines();
    let Some((marker, run, _)) = lines.next().and_then(fence) else {
        return false;
    };
    match lines.last().and_then(fence) {
        Some((closer, length, rest)) => {
            closer != marker || length < run || !rest.trim_matches([' ', '\t']).is_empty()
        }
        None => true,
    }
}

impl Row {
    /// The physical number of a continued row's first ordered item.
    pub(crate) fn first_number(&self) -> Option<u64> {
        let list = self.blocks.first()?.list.as_ref()?;
        (self.start_depth() == list.depth).then_some(list.ordinal)?
    }
}

#[cfg(test)]
#[path = "row_coordinates_tests.rs"]
mod coordinates_tests;

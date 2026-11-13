//! One line as a draft: its text, read alone after the carry it had, and
//! its visible characters with what each one looks like. Inline commands
//! try a spelling on a draft and keep it only when the line reads as they
//! intend; this is the one check, so no command reasons about delimiter
//! rules itself.
use super::super::super::line::{Entry, Neighbors, Role};
use crate::lines::{table, Carry, Kind, Span, SpanKind, TableRole};
use crate::InlineFormat;
use std::ops::Range;

pub(super) const BOLD: u16 = 1;
pub(super) const ITALIC: u16 = 2;
pub(super) const STRIKE: u16 = 4;
pub(super) const CODE: u16 = 8;
pub(super) const LINK: u16 = 16;
pub(super) const URL: u16 = 32;
pub(super) const IMAGE: u16 = 64;
pub(super) const WIKILINK: u16 = 128;
pub(super) const TAG: u16 = 256;
/// Formats a space may gain or lose unseen.
pub(super) const UNSEEN_ON_SPACE: u16 = BOLD | ITALIC | STRIKE;
/// Marks that are not formats.
pub(super) const MARKS: u16 = LINK | URL | IMAGE | WIKILINK | TAG;

pub(super) fn bit(format: InlineFormat) -> u16 {
    match format {
        InlineFormat::Bold => BOLD,
        InlineFormat::Italic => ITALIC,
        InlineFormat::Strike => STRIKE,
        InlineFormat::Code => CODE,
    }
}

pub(super) fn formats_of(style: u16) -> Vec<InlineFormat> {
    [
        InlineFormat::Bold,
        InlineFormat::Italic,
        InlineFormat::Strike,
        InlineFormat::Code,
    ]
    .into_iter()
    .filter(|format| style & bit(*format) != 0)
    .collect()
}

pub(super) fn span_bit(kind: &SpanKind) -> u16 {
    match kind {
        SpanKind::Bold => BOLD,
        SpanKind::Italic => ITALIC,
        SpanKind::Strike => STRIKE,
        SpanKind::Code => CODE,
        SpanKind::Link { .. } => LINK,
        SpanKind::Url { .. } => URL,
        SpanKind::Image { .. } => IMAGE,
        SpanKind::Wikilink { .. } => WIKILINK,
        SpanKind::Tag => TAG,
        SpanKind::Escape => 0,
    }
}

/// The source a span's marks surround: a link's label, a format's text, or
/// the whole of an atom (URL, image, wikilink, tag).
pub(super) fn inside(span: &Span) -> Range<usize> {
    if span.open.is_empty() && span.close.is_empty() {
        span.range.clone()
    } else {
        span.open.end..span.close.start
    }
}

/// One visible character of a line. Offsets are line-relative.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Glyph {
    pub src: usize,
    pub end: usize,
    pub display: usize,
    pub ch: char,
    pub style: u16,
}

impl Glyph {
    pub fn space(&self) -> bool {
        self.ch.is_whitespace()
    }
}

/// What a glyph must look like after an edit: its character, and `style`
/// on the bits of `mask`.
#[derive(Clone, Copy, Debug)]
pub(super) struct Expect {
    pub ch: char,
    pub style: u16,
    pub mask: u16,
}

impl Expect {
    /// `glyph` as it is. A space may gain or lose an unseen format.
    pub fn same(glyph: &Glyph) -> Self {
        Self {
            ch: glyph.ch,
            style: glyph.style,
            mask: if glyph.space() {
                !UNSEEN_ON_SPACE
            } else {
                u16::MAX
            },
        }
    }
}

pub(super) fn matches(glyphs: &[Glyph], expect: &[Expect]) -> bool {
    glyphs.len() == expect.len()
        && glyphs
            .iter()
            .zip(expect)
            .all(|(glyph, want)| glyph.ch == want.ch && (glyph.style ^ want.style) & want.mask == 0)
}

/// A line's text (with its ending) and what it needs to be read alone.
#[derive(Clone, Debug)]
pub(super) struct Draft {
    pub text: String,
    carry: Carry,
    /// The header's column count when the line is a table header (a reach
    /// back from the delimiter row under it, which a lone read cannot see).
    header: Option<usize>,
}

/// What must not change about a line's block when its inline text does.
pub(super) type Shape = (std::mem::Discriminant<Kind>, usize, Range<usize>, usize);

impl Draft {
    pub fn of(entry: &Entry) -> Self {
        Self {
            text: entry.text.clone(),
            carry: entry.carry.clone(),
            header: match entry.line.kind {
                Kind::Table {
                    role: TableRole::Header,
                    columns,
                } => Some(columns),
                _ => None,
            },
        }
    }

    pub fn with_text(&self, text: String) -> Self {
        Self {
            text,
            carry: self.carry.clone(),
            header: self.header,
        }
    }

    /// Read the draft as the line it is. `work` counts the bytes read.
    pub fn read(&self, work: &mut usize) -> Entry {
        *work += self.text.len();
        let mut carry = self.carry.clone();
        let mut entry = Entry::read(self.text.clone(), &mut carry, false);
        if let (Some(columns), Kind::Plain { .. }) = (self.header, &entry.line.kind) {
            entry.line.kind = Kind::Table {
                role: TableRole::Header,
                columns,
            };
        }
        entry.read_spans();
        entry.show(
            Neighbors {
                next: None,
                next_is_last: false,
            },
            false,
        );
        entry
    }
}

pub(super) fn shape(entry: &Entry) -> Shape {
    let line = &entry.line;
    // Only a table line has cells: a `|` line outside a table is plain text.
    let cells = match line.kind {
        Kind::Table { .. } => table::cells(entry.body()).len(),
        _ => 0,
    };
    (
        std::mem::discriminant(&line.kind),
        line.quote,
        line.marker.clone(),
        cells,
    )
}

/// Whether a line holds inline text a format or link can apply to.
pub(super) fn inline_line(entry: &Entry) -> bool {
    entry.view.role == Role::Text
        && matches!(
            entry.line.kind,
            Kind::Plain { .. }
                | Kind::Blank
                | Kind::Heading { .. }
                | Kind::List { .. }
                | Kind::Table {
                    role: TableRole::Header | TableRole::Row,
                    ..
                }
        )
}

/// The source ranges of a line inline marks may cover: its content, or each
/// table cell's content. Empty for a line that holds no inline text.
pub(super) fn regions(entry: &Entry) -> Vec<Range<usize>> {
    if !inline_line(entry) {
        return Vec::new();
    }
    let body = entry.body();
    match entry.line.kind {
        Kind::Table { .. } => table::cells(body)
            .iter()
            .map(|cell| table::trimmed(body, cell))
            .collect(),
        _ => vec![entry.line.content.clone()],
    }
}

/// The visible characters of a line's body, in order.
pub(super) fn glyphs(entry: &Entry) -> Vec<Glyph> {
    let mut out = Vec::new();
    if entry.view.role != Role::Text {
        return out;
    }
    let cuts = &entry.view.cuts;
    let mut next = 0;
    for (src, ch) in entry.body().char_indices() {
        while next < cuts.len() && cuts[next].0.end <= src {
            next += 1;
        }
        let hidden = cuts[next..]
            .iter()
            .take_while(|(range, _)| range.start <= src)
            .any(|(range, _)| range.end > src);
        if hidden {
            continue;
        }
        let style = entry
            .spans
            .iter()
            .filter(|span| inside(span).contains(&src))
            .fold(0, |style, span| style | span_bit(&span.kind));
        out.push(Glyph {
            src,
            end: src + ch.len_utf8(),
            display: entry.to_display(src),
            ch,
            style,
        });
    }
    out
}

/// The glyphs whose source lies in `range`.
pub(super) fn glyph_range(glyphs: &[Glyph], range: &Range<usize>) -> Range<usize> {
    let start = glyphs.partition_point(|glyph| glyph.src < range.start);
    let end = glyphs.partition_point(|glyph| glyph.src < range.end);
    start..end.max(start)
}

/// The source positions between glyph `index - 1` and glyph `index` where a
/// mark may be written: not inside a line marker, a mark or an escape.
pub(super) fn gap(entry: &Entry, glyphs: &[Glyph], index: usize) -> Vec<usize> {
    let from = if index == 0 { 0 } else { glyphs[index - 1].end };
    let to = glyphs
        .get(index)
        .map_or(entry.body_len(), |glyph| glyph.src);
    (from..=to)
        .filter(|&at| entry.text.is_char_boundary(at) && entry.allowed(at))
        .collect()
}

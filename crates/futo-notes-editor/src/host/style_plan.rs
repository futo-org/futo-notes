use crate::{InlineFormat, ProjectionSlice};

/// One cell of a table row: its content's range and column, with the column's alignment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableCellSpan {
    pub column: usize,
    pub start: usize,
    pub end: usize,
    pub alignment: crate::TableAlignment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListMarker {
    Bullet,
    Ordered,
    Task,
}

/// One styled stretch in the host's UTF-16 units, drawn from an engine projection. No Markdown
/// is parsed: every span names what the engine already decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StyleSpec {
    Inline {
        start: usize,
        end: usize,
        bold: bool,
        italic: bool,
        strike: bool,
        code: bool,
    },
    Heading {
        start: usize,
        end: usize,
        level: u8,
    },
    Quote {
        start: usize,
        end: usize,
        depth: usize,
    },
    ListRow {
        start: usize,
        end: usize,
        depth: usize,
        marker: ListMarker,
        number: Option<u64>,
        checked: bool,
        first: bool,
    },
    Code {
        start: usize,
        end: usize,
    },
    Metadata {
        start: usize,
        end: usize,
    },
    Link {
        start: usize,
        end: usize,
        destination: String,
    },
    Wikilink {
        start: usize,
        end: usize,
        label: String,
        note_id: Option<String>,
    },
    Divider {
        start: usize,
        end: usize,
    },
    /// One physical row of a root GFM table, drawn as a grid row from its cells.
    TableRow {
        start: usize,
        end: usize,
        columns: usize,
        header: bool,
        /// Where this row's table starts, so a host keys shared scrolling by it.
        table_start: usize,
        cells: Vec<TableCellSpan>,
    },
    /// The delimiter line: Markdown, with no visible row.
    TableDelimiter {
        start: usize,
        end: usize,
    },
    /// An image atom: its `![alt](destination)` glyphs are one unit. `vault` and `remote` are the
    /// engine's classification of the destination (a bare vault reference, an `http(s)` URL);
    /// a destination that is neither never loads.
    Image {
        start: usize,
        end: usize,
        destination: String,
        alt: String,
        vault: bool,
        remote: bool,
    },
}

impl StyleSpec {
    pub fn range(&self) -> (usize, usize) {
        match self {
            Self::Inline { start, end, .. }
            | Self::Heading { start, end, .. }
            | Self::Quote { start, end, .. }
            | Self::ListRow { start, end, .. }
            | Self::Code { start, end }
            | Self::Metadata { start, end }
            | Self::Link { start, end, .. }
            | Self::Wikilink { start, end, .. }
            | Self::Image { start, end, .. }
            | Self::TableRow { start, end, .. }
            | Self::TableDelimiter { start, end }
            | Self::Divider { start, end } => (*start, *end),
        }
    }

    fn with_range(&self, s: usize, e: usize, first: bool) -> Self {
        let mut out = self.clone();
        match &mut out {
            Self::Inline { start, end, .. }
            | Self::Heading { start, end, .. }
            | Self::Quote { start, end, .. }
            | Self::Code { start, end }
            | Self::Metadata { start, end }
            | Self::Link { start, end, .. }
            | Self::Wikilink { start, end, .. }
            | Self::Image { start, end, .. }
            | Self::TableRow { start, end, .. }
            | Self::TableDelimiter { start, end }
            | Self::Divider { start, end } => (*start, *end) = (s, e),
            Self::ListRow {
                start,
                end,
                first: f,
                ..
            } => {
                (*start, *end) = (s, e);
                *f = *f && first;
            }
        }
        out
    }
}

/// UTF-8 byte to UTF-16 unit within one projection's text, which starts at a known offset.
/// Bytes outside the text (a block may extend past its window) go to `outside`.
struct LocalOffsets<'a> {
    text: &'a str,
    start_byte: usize,
    start_utf16: usize,
    ascii: bool,
    cursor_byte: usize,
    cursor_utf16: usize,
}

impl<'a> LocalOffsets<'a> {
    fn new(text: &'a str, start_byte: usize, start_utf16: usize) -> Self {
        Self {
            text,
            start_byte,
            start_utf16,
            ascii: text.is_ascii(),
            cursor_byte: 0,
            cursor_utf16: 0,
        }
    }

    fn utf16(&mut self, byte: usize, outside: &mut dyn FnMut(usize) -> usize) -> usize {
        if byte < self.start_byte || byte > self.start_byte + self.text.len() {
            return outside(byte);
        }
        let local = byte - self.start_byte;
        if self.ascii {
            return self.start_utf16 + local;
        }
        if local < self.cursor_byte {
            (self.cursor_byte, self.cursor_utf16) = (0, 0);
        }
        // A byte inside a scalar rounds down to it; the engine never sends one.
        for c in self.text[self.cursor_byte..].chars() {
            if self.cursor_byte >= local {
                break;
            }
            self.cursor_byte += c.len_utf8();
            self.cursor_utf16 += c.len_utf16();
        }
        self.start_utf16 + self.cursor_utf16
    }
}

/// Projection to span descriptions in this display's UTF-16 units. `start_utf16` is where the
/// projection's text starts; `outside` converts a byte the text does not contain.
pub fn plan_styles(
    slice: &ProjectionSlice,
    start_utf16: usize,
    outside: &mut dyn FnMut(usize) -> usize,
) -> Vec<StyleSpec> {
    let mut local = LocalOffsets::new(&slice.text, slice.range.start.0, start_utf16);
    let text_end = start_utf16 + slice.text.encode_utf16().count();
    let units: Vec<u16> = slice.text.encode_utf16().collect();
    // The block a range ends on owns its line break (`\n` or `\r\n`), so a span reaches the next
    // line's start. An empty row is only its break: without it the span is zero-length.
    let with_break = |end: usize| {
        let at = end.wrapping_sub(start_utf16);
        match (units.get(at), units.get(at.wrapping_add(1))) {
            (Some(0x0A), _) => end + 1,
            (Some(0x0D), Some(0x0A)) => end + 2,
            _ => end,
        }
    };
    let mut out = Vec::new();
    let code_bodies: Vec<_> = {
        let mut bodies: Vec<_> = slice
            .blocks
            .iter()
            .filter(|b| b.code && b.range.start.0 < b.range.end.0)
            .map(|b| (b.range.start.0, b.range.end.0))
            .collect();
        bodies.sort();
        bodies
    };
    let mut previous = None;
    for block in &slice.blocks {
        // Hidden fence rows can share the first/last body's display point.
        if block.code && block.range.start == block.range.end {
            let at = code_bodies.partition_point(|b| b.0 <= block.range.start.0);
            if at > 0 && block.range.end.0 <= code_bodies[at - 1].1 {
                continue;
            }
        }
        // An empty fence arrives as several identical blocks; each would add its own margin.
        if previous == Some(block) {
            continue;
        }
        previous = Some(block);
        let s = local.utf16(block.range.start.0, outside);
        let e = with_break(local.utf16(block.range.end.0, outside)).min(text_end);
        if block.metadata {
            out.push(StyleSpec::Metadata { start: s, end: e });
        } else if block.code {
            out.push(StyleSpec::Code { start: s, end: e });
        } else if block.heading > 0 {
            out.push(StyleSpec::Heading {
                start: s,
                end: e,
                level: block.heading,
            });
        }
        if block.quote_depth > 0 {
            out.push(StyleSpec::Quote {
                start: s,
                end: e,
                depth: block.quote_depth,
            });
        }
        if let Some(list) = &block.list {
            let marker = if list.checked.is_some() {
                ListMarker::Task
            } else if list.number.is_some() {
                ListMarker::Ordered
            } else {
                ListMarker::Bullet
            };
            out.push(StyleSpec::ListRow {
                start: s,
                end: e,
                // The engine counts list nesting from 1.
                depth: list.depth.saturating_sub(1),
                marker,
                number: list.number,
                checked: list.checked == Some(true),
                first: list.first,
            });
        }
    }
    for run in &slice.runs {
        if run.formats.is_empty() {
            continue;
        }
        let has = |f| run.formats.contains(&f);
        out.push(StyleSpec::Inline {
            start: local.utf16(run.range.start.0, outside),
            end: local.utf16(run.range.end.0, outside),
            bold: has(InlineFormat::Bold),
            italic: has(InlineFormat::Italic),
            strike: has(InlineFormat::Strike),
            code: has(InlineFormat::Code),
        });
    }
    for link in &slice.links {
        out.push(StyleSpec::Link {
            start: local.utf16(link.range.start.0, outside),
            end: local.utf16(link.range.end.0, outside),
            destination: link.destination.clone(),
        });
    }
    for w in &slice.wikilinks {
        out.push(StyleSpec::Wikilink {
            start: local.utf16(w.range.start.0, outside),
            end: local.utf16(w.range.end.0, outside),
            label: w.label.clone(),
            note_id: w.note_id.clone(),
        });
    }
    for atom in &slice.atoms {
        let start = local.utf16(atom.range.start.0, outside);
        let end = local.utf16(atom.range.end.0, outside);
        match (atom.kind, &atom.image) {
            (crate::AtomKind::Divider, _) => out.push(StyleSpec::Divider { start, end }),
            (crate::AtomKind::Image, Some(image)) => out.push(StyleSpec::Image {
                start,
                end,
                destination: image.destination.clone(),
                alt: image.alt.clone(),
                vault: image.vault,
                remote: futo_notes_image::is_http_image_source(&image.destination),
            }),
            (crate::AtomKind::Image, None) => {}
        }
    }
    split_at_lines(out, &units, start_utf16)
}

/// Clip every span to the window (a block or run may overlap it, and arrive whole) and cut it at
/// line ends so none crosses a line; a piece keeps its line's `\n`. A list row's marker stays on
/// its first piece, and only when the clip left that piece's start alone: a row that began before
/// the window is already drawn. Atoms stay whole, and only those overlapping the window stay.
fn split_at_lines(specs: Vec<StyleSpec>, units: &[u16], start_utf16: usize) -> Vec<StyleSpec> {
    let text_end = start_utf16 + units.len();
    let mut out = Vec::with_capacity(specs.len());
    for spec in specs {
        let (start, end) = spec.range();
        let atom = matches!(
            spec,
            StyleSpec::Wikilink { .. }
                | StyleSpec::Divider { .. }
                | StyleSpec::Image { .. }
                | StyleSpec::TableRow { .. }
                | StyleSpec::TableDelimiter { .. }
        );
        if atom || end <= start {
            // An atom cannot be cut, but one outside the window (its paragraph overlaps) is not
            // this window's to style.
            if end <= start || (start < text_end && end > start_utf16) {
                out.push(spec);
            }
            continue;
        }
        let (clip_start, clip_end) = (start.max(start_utf16), end.min(text_end));
        let mut s = clip_start;
        let mut first = clip_start == start;
        while s < clip_end {
            let line_end = units[s - start_utf16..clip_end - start_utf16]
                .iter()
                .position(|&u| u == 0x0A)
                .map_or(clip_end, |nl| s + nl + 1);
            if first && line_end == end {
                out.push(spec);
                break;
            }
            out.push(spec.with_range(s, line_end, first));
            first = false;
            s = line_end;
        }
    }
    out
}

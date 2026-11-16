use super::table_plan::{plan_table, plan_table_line, table_of};
use crate::{CodeLineMark, InlineFormat, ProjectionSlice};

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
    /// An indented plain line: drawn at its indent, with no marker.
    Plain,
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
    /// A list line, or an indented plain line (`ListMarker::Plain`). `indent` is the line's own
    /// leading whitespace in columns (space 1, tab 4); `text` is the marker as typed (`-`, `3)`),
    /// empty on a plain line. `level` is the display nesting from list ancestors.
    ListRow {
        start: usize,
        end: usize,
        indent: usize,
        level: usize,
        marker: ListMarker,
        text: String,
        checked: bool,
        first: bool,
    },
    /// One line of a fenced code block. `line_number` is 1-based within the block; `first` and
    /// `last` are its first and last code lines (both on a one-line or empty block).
    Code {
        start: usize,
        end: usize,
        line_number: u32,
        mark: Option<CodeLineMark>,
        first: bool,
        last: bool,
    },
    /// A fenced code block the window touches, once per window, whole: `start` and `end` and
    /// `line_count` stay the same however the window cuts it. `end` is its last code line's end,
    /// that line's break excluded.
    CodeBlock {
        start: usize,
        end: usize,
        language: Option<String>,
        name: Option<String>,
        line_count: u32,
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
    /// A `#tag`, `#` included: coloured, still plain text.
    Tag {
        start: usize,
        end: usize,
    },
    Divider {
        start: usize,
        end: usize,
    },
    /// A list item's marker atom: one U+FFFC at the row's start standing for the marker's source
    /// (task box included). The host draws the row's marker over it from its `ListRow`.
    ListMarker {
        start: usize,
        end: usize,
    },
    /// One physical row of a root GFM table, drawn as a grid row from its cells. `columns` and
    /// each cell's alignment are its table's (`Table`) when planned.
    TableRow {
        start: usize,
        end: usize,
        columns: usize,
        header: bool,
        /// As `TableCell::row` counts: the header is 0, the first row under the delimiter 1.
        row: usize,
        /// Where this row's table starts, so a host keys shared scrolling by it.
        table_start: usize,
        cells: Vec<TableCellSpan>,
        /// Where each pipe that bounds a cell is, so a host hides them.
        pipes: Vec<usize>,
    },
    /// The delimiter line: Markdown, with no visible row.
    TableDelimiter {
        start: usize,
        end: usize,
    },
    /// A table the window touches, once per window, whole: `start` and `end`, `columns` (its
    /// widest row) and `alignments` (one per column) stay the same however the window cuts it.
    /// `end` is its last line's end, that line's break excluded.
    Table {
        start: usize,
        end: usize,
        columns: usize,
        alignments: Vec<crate::TableAlignment>,
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
            | Self::Code { start, end, .. }
            | Self::CodeBlock { start, end, .. }
            | Self::Metadata { start, end }
            | Self::Link { start, end, .. }
            | Self::Wikilink { start, end, .. }
            | Self::Tag { start, end }
            | Self::Image { start, end, .. }
            | Self::TableRow { start, end, .. }
            | Self::TableDelimiter { start, end }
            | Self::Table { start, end, .. }
            | Self::Divider { start, end }
            | Self::ListMarker { start, end } => (*start, *end),
        }
    }

    fn with_range(&self, s: usize, e: usize, first: bool) -> Self {
        let mut out = self.clone();
        match &mut out {
            Self::Inline { start, end, .. }
            | Self::Heading { start, end, .. }
            | Self::Quote { start, end, .. }
            | Self::Code { start, end, .. }
            | Self::CodeBlock { start, end, .. }
            | Self::Metadata { start, end }
            | Self::Link { start, end, .. }
            | Self::Wikilink { start, end, .. }
            | Self::Tag { start, end }
            | Self::Image { start, end, .. }
            | Self::TableRow { start, end, .. }
            | Self::TableDelimiter { start, end }
            | Self::Table { start, end, .. }
            | Self::Divider { start, end }
            | Self::ListMarker { start, end } => (*start, *end) = (s, e),
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
    // line's start. An empty row is only its break: without it the span is zero-length. A `\r`
    // closing the window, or a block ending just before a window that opens on `\n`, is a `\r\n`
    // cut by the window (rows end at `\n`, so no block ends before any other lone `\r`): it owns
    // the pair as the whole plan does.
    let with_break = |end: usize| {
        if end + 1 == start_utf16 && units.first() == Some(&0x0A) {
            return end + 2;
        }
        let at = end.wrapping_sub(start_utf16);
        match (units.get(at), units.get(at.wrapping_add(1))) {
            (Some(0x0A), _) => end + 1,
            (Some(0x0D), Some(0x0A)) => end + 2,
            (Some(0x0D), None) => end + 1,
            _ => end,
        }
    };
    let mut out = Vec::new();
    for block in &slice.code_blocks {
        out.push(StyleSpec::CodeBlock {
            start: local.utf16(block.range.start.0, outside),
            end: local.utf16(block.range.end.0, outside),
            language: block.language.clone(),
            name: block.name.clone(),
            line_count: block.line_count,
        });
    }
    for table in &slice.tables {
        out.push(plan_table(table, &mut |byte| local.utf16(byte, outside)));
    }
    for block in &slice.blocks {
        if let Some(table) = table_of(slice, block) {
            out.extend(plan_table_line(block, table, &mut |byte| {
                local.utf16(byte, outside)
            }));
        }
        let s = local.utf16(block.range.start.0, outside);
        let e = with_break(local.utf16(block.range.end.0, outside)).min(text_end);
        if block.metadata {
            out.push(StyleSpec::Metadata { start: s, end: e });
        } else if let Some(code) = &block.code {
            out.push(StyleSpec::Code {
                start: s,
                end: e,
                line_number: code.line_number,
                mark: code.mark,
                first: code.first,
                last: code.last,
            });
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
            let marker = if list.marker.is_empty() {
                ListMarker::Plain
            } else if list.checked.is_some() {
                ListMarker::Task
            } else if list.ordered {
                ListMarker::Ordered
            } else {
                ListMarker::Bullet
            };
            out.push(StyleSpec::ListRow {
                start: s,
                end: e,
                indent: list.indent,
                level: list.level,
                marker,
                text: list.marker.clone(),
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
    for tag in &slice.tags {
        out.push(StyleSpec::Tag {
            start: local.utf16(tag.start.0, outside),
            end: local.utf16(tag.end.0, outside),
        });
    }
    for atom in &slice.atoms {
        let start = local.utf16(atom.range.start.0, outside);
        let end = local.utf16(atom.range.end.0, outside);
        match (atom.kind, &atom.image) {
            (crate::AtomKind::Divider, _) => out.push(StyleSpec::Divider { start, end }),
            (crate::AtomKind::ListMarker, _) => out.push(StyleSpec::ListMarker { start, end }),
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
/// the window is already drawn. Atoms stay whole, and only those overlapping the window stay. A
/// code block, a table and a table's lines stay whole and always stay: the projection holds only
/// those the window touches.
fn split_at_lines(specs: Vec<StyleSpec>, units: &[u16], start_utf16: usize) -> Vec<StyleSpec> {
    let text_end = start_utf16 + units.len();
    let mut out = Vec::with_capacity(specs.len());
    for spec in specs {
        if matches!(
            spec,
            StyleSpec::CodeBlock { .. }
                | StyleSpec::Table { .. }
                | StyleSpec::TableRow { .. }
                | StyleSpec::TableDelimiter { .. }
        ) {
            out.push(spec);
            continue;
        }
        let (start, end) = spec.range();
        let atom = matches!(
            spec,
            StyleSpec::Wikilink { .. }
                | StyleSpec::Divider { .. }
                | StyleSpec::ListMarker { .. }
                | StyleSpec::Image { .. }
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

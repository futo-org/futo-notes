//! `futo_notes_editor::host::StyleSpec` in the host's UTF-16 units, as UniFFI sees it.
use futo_notes_editor::host::{ListMarker, StyleSpec};

use super::projection::EditorCodeLineMark;
use super::tables::EditorTableAlignment;

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorListMarker {
    Bullet,
    Ordered,
    Task,
    /// An indented plain line: drawn at its indent, with no marker.
    Plain,
}

/// One styled stretch of the display in UTF-16 units (see `futo_notes_editor::host::StyleSpec`).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum EditorStyleSpan {
    Inline {
        start: u64,
        end: u64,
        bold: bool,
        italic: bool,
        strike: bool,
        code: bool,
    },
    Heading {
        start: u64,
        end: u64,
        level: u8,
    },
    Quote {
        start: u64,
        end: u64,
        depth: u64,
    },
    /// `indent` is the line's own leading whitespace in columns; `text` the marker as typed.
    ListRow {
        start: u64,
        end: u64,
        indent: u64,
        level: u64,
        marker: EditorListMarker,
        text: String,
        checked: bool,
        first: bool,
    },
    /// One line of a fenced code block: `line_number` is 1-based within the block; `first` and
    /// `last` are its first and last code lines.
    Code {
        start: u64,
        end: u64,
        line_number: u32,
        mark: Option<EditorCodeLineMark>,
        first: bool,
        last: bool,
    },
    /// A fenced code block the window touches, whole however the window cuts it; `end` excludes
    /// its last line's break.
    CodeBlock {
        start: u64,
        end: u64,
        language: Option<String>,
        name: Option<String>,
        line_count: u32,
    },
    Metadata {
        start: u64,
        end: u64,
    },
    Link {
        start: u64,
        end: u64,
        destination: String,
    },
    Wikilink {
        start: u64,
        end: u64,
        label: String,
        note_id: Option<String>,
    },
    /// A `#tag`, `#` included: coloured, still plain text.
    Tag {
        start: u64,
        end: u64,
    },
    Divider {
        start: u64,
        end: u64,
    },
    Image {
        start: u64,
        end: u64,
        destination: String,
        alt: String,
        vault: bool,
        remote: bool,
    },
    /// `row` counts as a table cell's row does (header 0); `pipes` are where each pipe that
    /// bounds a cell is.
    TableRow {
        start: u64,
        end: u64,
        columns: u64,
        header: bool,
        row: u64,
        table_start: u64,
        cells: Vec<EditorStyleCell>,
        pipes: Vec<u64>,
    },
    TableDelimiter {
        start: u64,
        end: u64,
    },
    /// A table the window touches, whole however the window cuts it; `end` excludes its last
    /// line's break. `columns` is its widest row; one alignment per column.
    Table {
        start: u64,
        end: u64,
        columns: u64,
        alignments: Vec<EditorTableAlignment>,
    },
}

/// One cell of a table row span: its content's UTF-16 range, column and alignment.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EditorStyleCell {
    pub column: u64,
    pub start: u64,
    pub end: u64,
    pub alignment: EditorTableAlignment,
}

impl From<StyleSpec> for EditorStyleSpan {
    fn from(spec: StyleSpec) -> Self {
        let u = |v: usize| v as u64;
        match spec {
            StyleSpec::Inline {
                start,
                end,
                bold,
                italic,
                strike,
                code,
            } => Self::Inline {
                start: u(start),
                end: u(end),
                bold,
                italic,
                strike,
                code,
            },
            StyleSpec::Heading { start, end, level } => Self::Heading {
                start: u(start),
                end: u(end),
                level,
            },
            StyleSpec::Quote { start, end, depth } => Self::Quote {
                start: u(start),
                end: u(end),
                depth: u(depth),
            },
            StyleSpec::ListRow {
                start,
                end,
                indent,
                level,
                marker,
                text,
                checked,
                first,
            } => Self::ListRow {
                start: u(start),
                end: u(end),
                indent: u(indent),
                level: u(level),
                marker: match marker {
                    ListMarker::Bullet => EditorListMarker::Bullet,
                    ListMarker::Ordered => EditorListMarker::Ordered,
                    ListMarker::Task => EditorListMarker::Task,
                    ListMarker::Plain => EditorListMarker::Plain,
                },
                text,
                checked,
                first,
            },
            StyleSpec::Code {
                start,
                end,
                line_number,
                mark,
                first,
                last,
            } => Self::Code {
                start: u(start),
                end: u(end),
                line_number,
                mark: mark.map(Into::into),
                first,
                last,
            },
            StyleSpec::CodeBlock {
                start,
                end,
                language,
                name,
                line_count,
            } => Self::CodeBlock {
                start: u(start),
                end: u(end),
                language,
                name,
                line_count,
            },
            StyleSpec::Metadata { start, end } => Self::Metadata {
                start: u(start),
                end: u(end),
            },
            StyleSpec::Link {
                start,
                end,
                destination,
            } => Self::Link {
                start: u(start),
                end: u(end),
                destination,
            },
            StyleSpec::Wikilink {
                start,
                end,
                label,
                note_id,
            } => Self::Wikilink {
                start: u(start),
                end: u(end),
                label,
                note_id,
            },
            StyleSpec::Tag { start, end } => Self::Tag {
                start: u(start),
                end: u(end),
            },
            StyleSpec::Divider { start, end } => Self::Divider {
                start: u(start),
                end: u(end),
            },
            StyleSpec::TableRow {
                start,
                end,
                columns,
                header,
                row,
                table_start,
                cells,
                pipes,
            } => Self::TableRow {
                start: u(start),
                end: u(end),
                columns: u(columns),
                header,
                row: u(row),
                table_start: u(table_start),
                pipes: pipes.into_iter().map(u).collect(),
                cells: cells
                    .into_iter()
                    .map(|cell| EditorStyleCell {
                        column: u(cell.column),
                        start: u(cell.start),
                        end: u(cell.end),
                        alignment: cell.alignment.into(),
                    })
                    .collect(),
            },
            StyleSpec::TableDelimiter { start, end } => Self::TableDelimiter {
                start: u(start),
                end: u(end),
            },
            StyleSpec::Table {
                start,
                end,
                columns,
                alignments,
            } => Self::Table {
                start: u(start),
                end: u(end),
                columns: u(columns),
                alignments: alignments.into_iter().map(Into::into).collect(),
            },
            StyleSpec::Image {
                start,
                end,
                destination,
                alt,
                vault,
                remote,
            } => Self::Image {
                start: u(start),
                end: u(end),
                destination,
                alt,
                vault,
                remote,
            },
        }
    }
}

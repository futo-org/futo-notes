//! `futo_notes_editor::ProjectionSlice` as UniFFI sees it.
use futo_notes_editor as editor;

use super::{EditorByteRange, EditorLinkDescription, EditorSemanticRun, EditorWikilinkDescription};

#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorProjection {
    pub revision: u64,
    pub range: EditorByteRange,
    pub text: String,
    pub runs: Vec<EditorSemanticRun>,
    pub correspondence: Vec<super::correspondence::EditorCorrespondence>,
    pub blocks: Vec<EditorBlockDescription>,
    pub links: Vec<EditorLinkDescription>,
    pub wikilinks: Vec<EditorWikilinkDescription>,
    pub atoms: Vec<super::images::EditorAtomDescription>,
    /// Each code block the projection's lines belong to, whole.
    pub code_blocks: Vec<EditorCodeBlockDescription>,
    /// Each table the projection's lines belong to, whole.
    pub tables: Vec<EditorTableBlockDescription>,
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorListDescription {
    pub indent: u64,
    pub level: u64,
    pub marker: String,
    pub ordered: bool,
    pub checked: Option<bool>,
    pub first: bool,
}
impl From<editor::ListDescription> for EditorListDescription {
    fn from(value: editor::ListDescription) -> Self {
        Self {
            indent: value.indent as u64,
            level: value.level as u64,
            marker: value.marker,
            ordered: value.ordered,
            checked: value.checked,
            first: value.first,
        }
    }
}
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorBlockDescription {
    pub range: EditorByteRange,
    pub heading: u8,
    pub quote_depth: u64,
    pub divider: bool,
    pub list: Option<EditorListDescription>,
    /// A line of fenced code; its block is in `EditorProjection.code_blocks`.
    pub code: Option<EditorCodeLineDescription>,
    /// A line of a table; its table is in `EditorProjection.tables`.
    pub table: Option<EditorTableLineDescription>,
    /// Leading front matter, shown verbatim; hosts may render it as a panel.
    pub metadata: bool,
}
/// One shown line of a fenced code block (an empty block shows one).
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorCodeLineDescription {
    /// 1-based within its block.
    pub line_number: u32,
    pub first: bool,
    pub last: bool,
    pub mark: Option<EditorCodeLineMark>,
}
impl From<editor::CodeLineDescription> for EditorCodeLineDescription {
    fn from(value: editor::CodeLineDescription) -> Self {
        Self {
            line_number: value.line_number,
            first: value.first,
            last: value.last,
            mark: value.mark.map(Into::into),
        }
    }
}
/// A line mark from the opening fence's `hl:` and `ll:` options.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorCodeLineMark {
    Highlight,
    Lowlight,
}
impl From<editor::CodeLineMark> for EditorCodeLineMark {
    fn from(value: editor::CodeLineMark) -> Self {
        match value {
            editor::CodeLineMark::Highlight => Self::Highlight,
            editor::CodeLineMark::Lowlight => Self::Lowlight,
        }
    }
}
/// A fenced code block, whole: `range` runs from its first code line's start to its last code
/// line's end (that line's break excluded).
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorCodeBlockDescription {
    pub range: EditorByteRange,
    pub language: Option<String>,
    pub name: Option<String>,
    pub line_count: u32,
}
impl From<editor::CodeBlockDescription> for EditorCodeBlockDescription {
    fn from(value: editor::CodeBlockDescription) -> Self {
        Self {
            range: value.range.into(),
            language: value.language,
            name: value.name,
            line_count: value.line_count,
        }
    }
}
/// What a table line is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorTableLineRole {
    Header,
    Delimiter,
    Row,
}
/// One line of a table: `row` counts as `EditorTableCell.row` does (header 0, the delimiter row
/// 0 too), each cell's content as `EditorTableCell.content`, and where each pipe that bounds a
/// cell shows.
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorTableLineDescription {
    pub role: EditorTableLineRole,
    pub row: u32,
    pub cells: Vec<EditorByteRange>,
    pub pipes: Vec<u64>,
}
impl From<editor::TableLineDescription> for EditorTableLineDescription {
    fn from(value: editor::TableLineDescription) -> Self {
        Self {
            role: match value.role {
                editor::TableLineRole::Header => EditorTableLineRole::Header,
                editor::TableLineRole::Delimiter => EditorTableLineRole::Delimiter,
                editor::TableLineRole::Row => EditorTableLineRole::Row,
            },
            row: value.row as u32,
            cells: value.cells.into_iter().map(Into::into).collect(),
            pipes: value.pipes.into_iter().map(|pipe| pipe.0 as u64).collect(),
        }
    }
}
/// A table, whole: `range` runs from its header's start to its last line's end (that line's
/// break excluded); `columns` is its widest row, with one alignment per column.
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorTableBlockDescription {
    pub range: EditorByteRange,
    pub columns: u32,
    pub alignments: Vec<super::tables::EditorTableAlignment>,
}
impl From<editor::TableBlockDescription> for EditorTableBlockDescription {
    fn from(value: editor::TableBlockDescription) -> Self {
        Self {
            range: value.range.into(),
            columns: value.columns as u32,
            alignments: value.alignments.into_iter().map(Into::into).collect(),
        }
    }
}
impl From<editor::ProjectionSlice> for EditorProjection {
    fn from(value: editor::ProjectionSlice) -> Self {
        Self {
            revision: value.revision.0,
            range: value.range.into(),
            text: value.text,
            links: value.links.into_iter().map(Into::into).collect(),
            wikilinks: value.wikilinks.into_iter().map(Into::into).collect(),
            atoms: value.atoms.into_iter().map(Into::into).collect(),
            blocks: value
                .blocks
                .into_iter()
                .map(|block| EditorBlockDescription {
                    range: block.range.into(),
                    heading: block.heading,
                    quote_depth: block.quote_depth as u64,
                    divider: block.divider,
                    list: block.list.map(Into::into),
                    code: block.code.map(Into::into),
                    table: block.table.map(Into::into),
                    metadata: block.metadata,
                })
                .collect(),
            runs: value
                .runs
                .into_iter()
                .map(|run| EditorSemanticRun {
                    range: run.range.into(),
                    formats: run.formats.into_iter().map(Into::into).collect(),
                })
                .collect(),
            correspondence: value.correspondence.into_iter().map(Into::into).collect(),
            code_blocks: value.code_blocks.into_iter().map(Into::into).collect(),
            tables: value.tables.into_iter().map(Into::into).collect(),
        }
    }
}

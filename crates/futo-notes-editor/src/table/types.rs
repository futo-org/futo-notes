//! The public table vocabulary: what a view sees, and what it asks for.
use crate::{DisplayRange, SourceRange};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TableAlignment {
    None,
    Left,
    Center,
    Right,
}

/// One editable cell. `source` and `content` cover the cell's text without the
/// padding spaces; an empty cell has an empty range inside its padding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableCell {
    pub row: usize,
    pub column: usize,
    pub source: SourceRange,
    pub content: DisplayRange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableFocus {
    pub row: usize,
    pub column: usize,
}

/// Which structural commands apply to the focused cell. Platform controls only
/// reflect these flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableControls {
    pub insert_row_above: bool,
    pub insert_row_below: bool,
    pub delete_row: bool,
    pub insert_column_left: bool,
    pub insert_column_right: bool,
    pub delete_column: bool,
}

/// A recognized root-level GFM table. Row 0 is the header; the delimiter row is
/// never a row. A body row shorter than `columns` lists only the cells it has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableDescription {
    pub source: SourceRange,
    pub display: DisplayRange,
    pub columns: usize,
    pub alignments: Vec<TableAlignment>,
    pub rows: Vec<Vec<TableCell>>,
    pub focus: Option<TableFocus>,
    pub controls: Option<TableControls>,
    /// Display extent of each row's physical line, header first (one per `rows`
    /// entry). For hosts that lay out one visual line per row. Native-only: not
    /// part of the portable payload.
    #[serde(skip)]
    pub row_lines: Vec<DisplayRange>,
    /// Display extent of the delimiter line. Native-only, like `row_lines`.
    #[serde(skip)]
    pub delimiter_line: Option<DisplayRange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TableKey {
    Tab,
    ShiftTab,
    Enter,
    ModEnter,
    ShiftEnter,
}

/// A key handled inside a table: a selection move or one accepted edit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TableOutcome {
    Selected(crate::SelectionChange),
    Edited(Box<crate::ViewChange>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TableCommand {
    InsertRowAbove,
    InsertRowBelow,
    DeleteRow,
    InsertColumnLeft,
    InsertColumnRight,
    DeleteColumn,
}

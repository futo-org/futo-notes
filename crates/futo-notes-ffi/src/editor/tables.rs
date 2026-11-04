//! Thin byte-coordinate table projection. Table grammar
//! and history stay in the canonical editor/store owners.
use super::*;
use futo_notes_editor as editor;

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorTableAlignment {
    None,
    Left,
    Center,
    Right,
}

#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorTableCell {
    pub row: u32,
    pub column: u32,
    pub source: EditorSourceByteRange,
    pub content: EditorByteRange,
}

#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorTableFocus {
    pub row: u32,
    pub column: u32,
}

#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorTableControls {
    pub insert_row_above: bool,
    pub insert_row_below: bool,
    pub delete_row: bool,
    pub insert_column_left: bool,
    pub insert_column_right: bool,
    pub delete_column: bool,
}

#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorTableDescription {
    pub source: EditorSourceByteRange,
    pub display: EditorByteRange,
    pub columns: u32,
    pub alignments: Vec<EditorTableAlignment>,
    pub rows: Vec<Vec<EditorTableCell>>,
    pub focus: Option<EditorTableFocus>,
    pub controls: Option<EditorTableControls>,
    /// Display extent of each row's line, header first, and of the delimiter line.
    pub row_lines: Vec<EditorByteRange>,
    pub delimiter_line: Option<EditorByteRange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorTableKey {
    Tab,
    ShiftTab,
    Enter,
    ModEnter,
    ShiftEnter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EditorTableCommand {
    InsertRowAbove,
    InsertRowBelow,
    DeleteRow,
    InsertColumnLeft,
    InsertColumnRight,
    DeleteColumn,
}

/// Exactly one field is set: a selection move, or one accepted edit.
#[derive(Debug, uniffi::Record)]
pub struct EditorTableOutcome {
    pub selected: Option<EditorSelectionChange>,
    pub edited: Option<EditorViewChange>,
}

impl From<editor::TableKey> for EditorTableKey {
    fn from(value: editor::TableKey) -> Self {
        match value {
            editor::TableKey::Tab => Self::Tab,
            editor::TableKey::ShiftTab => Self::ShiftTab,
            editor::TableKey::Enter => Self::Enter,
            editor::TableKey::ModEnter => Self::ModEnter,
            editor::TableKey::ShiftEnter => Self::ShiftEnter,
        }
    }
}

impl From<EditorTableKey> for editor::TableKey {
    fn from(value: EditorTableKey) -> Self {
        match value {
            EditorTableKey::Tab => Self::Tab,
            EditorTableKey::ShiftTab => Self::ShiftTab,
            EditorTableKey::Enter => Self::Enter,
            EditorTableKey::ModEnter => Self::ModEnter,
            EditorTableKey::ShiftEnter => Self::ShiftEnter,
        }
    }
}

impl From<EditorTableCommand> for editor::TableCommand {
    fn from(value: EditorTableCommand) -> Self {
        match value {
            EditorTableCommand::InsertRowAbove => Self::InsertRowAbove,
            EditorTableCommand::InsertRowBelow => Self::InsertRowBelow,
            EditorTableCommand::DeleteRow => Self::DeleteRow,
            EditorTableCommand::InsertColumnLeft => Self::InsertColumnLeft,
            EditorTableCommand::InsertColumnRight => Self::InsertColumnRight,
            EditorTableCommand::DeleteColumn => Self::DeleteColumn,
        }
    }
}

impl From<editor::TableAlignment> for EditorTableAlignment {
    fn from(value: editor::TableAlignment) -> Self {
        match value {
            editor::TableAlignment::None => Self::None,
            editor::TableAlignment::Left => Self::Left,
            editor::TableAlignment::Center => Self::Center,
            editor::TableAlignment::Right => Self::Right,
        }
    }
}

impl From<editor::TableDescription> for EditorTableDescription {
    fn from(value: editor::TableDescription) -> Self {
        let source = |range: editor::SourceRange| EditorSourceByteRange {
            start: range.start.0 as u64,
            end: range.end.0 as u64,
        };
        Self {
            source: source(value.source),
            display: value.display.into(),
            columns: value.columns as u32,
            alignments: value.alignments.into_iter().map(Into::into).collect(),
            rows: value
                .rows
                .into_iter()
                .map(|row| {
                    row.into_iter()
                        .map(|cell| EditorTableCell {
                            row: cell.row as u32,
                            column: cell.column as u32,
                            source: source(cell.source),
                            content: cell.content.into(),
                        })
                        .collect()
                })
                .collect(),
            focus: value.focus.map(|focus| EditorTableFocus {
                row: focus.row as u32,
                column: focus.column as u32,
            }),
            controls: value.controls.map(|controls| EditorTableControls {
                insert_row_above: controls.insert_row_above,
                insert_row_below: controls.insert_row_below,
                delete_row: controls.delete_row,
                insert_column_left: controls.insert_column_left,
                insert_column_right: controls.insert_column_right,
                delete_column: controls.delete_column,
            }),
            row_lines: value.row_lines.into_iter().map(Into::into).collect(),
            delimiter_line: value.delimiter_line.map(Into::into),
        }
    }
}

impl From<editor::TableOutcome> for EditorTableOutcome {
    fn from(value: editor::TableOutcome) -> Self {
        match value {
            editor::TableOutcome::Selected(change) => Self {
                selected: Some(change.into()),
                edited: None,
            },
            editor::TableOutcome::Edited(change) => Self {
                selected: None,
                edited: Some((*change).into()),
            },
        }
    }
}

#[uniffi::export]
impl NativeEditorSession {
    pub fn inspect_table(
        &self,
        expected: u64,
        range: EditorByteRange,
    ) -> Result<Option<EditorTableDescription>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .inspect_table(Revision(expected), range.try_into()?)?
                .map(Into::into))
        })
    }

    /// Every table starting in `range`, in order: one call where a host would
    /// otherwise ask `inspect_table` at each block.
    pub fn inspect_tables(
        &self,
        expected: u64,
        range: EditorByteRange,
    ) -> Result<Vec<EditorTableDescription>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .inspect_tables(Revision(expected), range.try_into()?)?
                .into_iter()
                .map(Into::into)
                .collect())
        })
    }

    pub fn table_command(
        &self,
        expected: u64,
        range: EditorByteRange,
        command: EditorTableCommand,
    ) -> Result<Option<EditorViewChange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .table_command(Revision(expected), range.try_into()?, command.into())?
                .map(Into::into))
        })
    }

    pub fn table_key(
        &self,
        expected: u64,
        key: EditorTableKey,
    ) -> Result<Option<EditorTableOutcome>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .table_key(Revision(expected), key.into())?
                .map(Into::into))
        })
    }
}

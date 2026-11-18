//! Portable table operations are ordinary input: applied now, acknowledged later.
use super::*;
use crate::{DisplayUtf16Range, TableCommand, TableDescription, TableKey};

/// A table key either moves the selection (nothing to append) or applies one
/// edit and issues its request.
pub enum PortableTableStep {
    Selected(crate::SelectionChange),
    Edited(Box<Applied>),
}

impl PortableSession {
    /// Whether the caret writes a table's delimiter row. An input that
    /// changes no source returns no change, so a view reads it here.
    pub fn writes_delimiter_row(&self) -> bool {
        self.engine.writes_delimiter_row()
    }

    pub fn inspect_table(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Option<TableDescription>, PortableError> {
        Ok(self.engine.inspect_table(expected, range)?)
    }

    pub fn inspect_tables(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Vec<TableDescription>, PortableError> {
        Ok(self.engine.inspect_tables(expected, range)?)
    }

    pub fn inspect_table_utf16(
        &self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<Option<TableDescription>, PortableError> {
        Ok(self.engine.inspect_table_utf16(expected, range)?)
    }

    pub fn table_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: TableCommand,
    ) -> Result<Option<Applied>, PortableError> {
        self.apply_input(|engine, accept| engine.table_command(expected, range, command, accept))
    }

    pub fn table_command_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        command: TableCommand,
    ) -> Result<Option<Applied>, PortableError> {
        self.apply_input(|engine, accept| {
            engine.table_command_utf16(expected, range, command, accept)
        })
    }

    pub fn table_key(
        &mut self,
        expected: Revision,
        key: TableKey,
    ) -> Result<Option<PortableTableStep>, PortableError> {
        let (outcome, record) =
            self.record_edit(|engine, accept| engine.table_key(expected, key, accept))?;
        Ok(match outcome {
            None => None,
            Some(crate::TableOutcome::Selected(change)) => {
                Some(PortableTableStep::Selected(change))
            }
            Some(crate::TableOutcome::Edited(change)) => self
                .issue_accepted(record, Some(*change))
                .map(|applied| PortableTableStep::Edited(Box::new(applied))),
        })
    }
}

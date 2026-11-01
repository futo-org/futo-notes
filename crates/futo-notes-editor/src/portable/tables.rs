//! Portable table operations use the same ordered append/ack barrier as input.
use super::*;
use crate::{DisplayUtf16Range, TableCommand, TableDescription, TableKey};

type Accept<'a> = dyn FnMut(&SourceEdit) -> Result<(), String> + 'a;

/// A table key either moves the selection (nothing to append) or stages one
/// edit behind the usual acknowledgement barrier.
pub enum PortableTableStep {
    Selected(crate::SelectionChange),
    Edited(HostRequest),
}

impl PortableSession {
    pub fn inspect_table(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Option<TableDescription>, PortableError> {
        self.ready()?;
        Ok(self.engine.inspect_table(expected, range)?)
    }

    pub fn inspect_table_utf16(
        &self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<Option<TableDescription>, PortableError> {
        self.ready()?;
        Ok(self.engine.inspect_table_utf16(expected, range)?)
    }

    pub fn table_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: TableCommand,
    ) -> Result<Option<HostRequest>, PortableError> {
        self.stage_table(|engine, accept| engine.table_command(expected, range, command, accept))
    }

    pub fn table_command_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        command: TableCommand,
    ) -> Result<Option<HostRequest>, PortableError> {
        self.stage_table(|engine, accept| {
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
            Some(crate::TableOutcome::Edited(change)) => Some(PortableTableStep::Edited(
                self.stage(record.unwrap(), *change)?,
            )),
        })
    }

    fn stage_table(
        &mut self,
        operation: impl FnOnce(
            &mut EditorSession,
            &mut Accept,
        ) -> Result<Option<ViewChange>, EditorError>,
    ) -> Result<Option<HostRequest>, PortableError> {
        let (change, record) = self.record_edit(operation)?;
        change
            .map(|change| self.stage(record.unwrap(), change))
            .transpose()
    }

    /// Run an engine operation, keeping the edit it handed the host.
    fn record_edit<T>(
        &mut self,
        operation: impl FnOnce(&mut EditorSession, &mut Accept<'_>) -> Result<T, EditorError>,
    ) -> Result<(T, Option<SourceEdit>), PortableError> {
        self.ready()?;
        let mut record = None;
        let result = operation(&mut self.engine, &mut |edit| {
            record = Some(edit.clone());
            Ok(())
        })?;
        Ok((result, record))
    }
}

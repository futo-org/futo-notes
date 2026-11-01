//! Portable table operations use the same ordered append/ack barrier as input.
use super::*;
use crate::{TableCommand, TableDescription, TableKey};

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

    pub fn replace_in_cell(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
    ) -> Result<Option<HostRequest>, PortableError> {
        self.stage_table(|engine, accept| engine.replace_in_cell(expected, range, inserted, accept))
    }

    pub fn table_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: TableCommand,
    ) -> Result<Option<HostRequest>, PortableError> {
        self.stage_table(|engine, accept| engine.table_command(expected, range, command, accept))
    }

    pub fn table_key(
        &mut self,
        expected: Revision,
        key: TableKey,
    ) -> Result<Option<PortableTableStep>, PortableError> {
        self.ready()?;
        let mut record = None;
        let outcome = self.engine.table_key(expected, key, &mut |edit| {
            record = Some(edit.clone());
            Ok(())
        })?;
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
            &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        ) -> Result<Option<ViewChange>, EditorError>,
    ) -> Result<Option<HostRequest>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = operation(&mut self.engine, &mut |edit| {
            record = Some(edit.clone());
            Ok(())
        })?;
        change
            .map(|change| self.stage(record.unwrap(), change))
            .transpose()
    }
}

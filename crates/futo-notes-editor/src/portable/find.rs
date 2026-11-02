//! Find is note-local and never appends: it queries the displayed revision and
//! may move the selection, like any selection change, but never edits source.
use super::*;
use crate::{CaretDirection, FindReport, FindScanRequest, FindScanResult};

impl PortableSession {
    pub fn find_set_query(
        &mut self,
        expected: Revision,
        query: &str,
    ) -> Result<FindReport, PortableError> {
        self.ready()?;
        Ok(self.engine.find_set_query(expected, query)?)
    }

    pub fn find_step(
        &mut self,
        expected: Revision,
        direction: CaretDirection,
    ) -> Result<FindReport, PortableError> {
        self.ready()?;
        Ok(self.engine.find_step(expected, direction)?)
    }

    /// Closing always succeeds, even with input awaiting acknowledgement.
    pub fn find_close(&mut self) -> FindReport {
        self.engine.find_close()
    }

    pub fn find_report(&mut self) -> Result<FindReport, PortableError> {
        self.displayed()?;
        Ok(self.engine.find_report())
    }

    pub fn find_matches(
        &mut self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Vec<DisplayRange>, PortableError> {
        self.displayed()?;
        Ok(self.engine.find_matches(expected, range)?)
    }

    pub fn find_matches_utf16(
        &mut self,
        expected: Revision,
        range: crate::DisplayUtf16Range,
    ) -> Result<Vec<DisplayRange>, PortableError> {
        self.displayed()?;
        Ok(self.engine.find_matches_utf16(expected, range)?)
    }

    pub fn find_scan_request(&self) -> Result<Option<FindScanRequest>, PortableError> {
        self.displayed()?;
        Ok(self.engine.find_scan_request())
    }

    /// A result for any other revision or query generation yields `None`.
    pub fn find_apply_scan(
        &mut self,
        result: &FindScanResult,
    ) -> Result<Option<FindReport>, PortableError> {
        self.displayed()?;
        Ok(self.engine.find_apply_scan(result))
    }

    fn displayed(&self) -> Result<(), PortableError> {
        if self.pending.is_some() {
            return Err(PortableError::Busy);
        }
        Ok(())
    }
}

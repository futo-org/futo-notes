//! Words are reads of the page's draft (`engine/words.rs`).
use super::*;
use crate::{CaretDirection, DisplayOffset};

impl PortableSession {
    pub fn word_at(
        &self,
        expected: Revision,
        offset: DisplayOffset,
    ) -> Result<DisplayRange, PortableError> {
        Ok(self.engine.word_at(expected, offset)?)
    }

    pub fn word_stop(
        &self,
        expected: Revision,
        offset: DisplayOffset,
        direction: CaretDirection,
    ) -> Result<DisplayOffset, PortableError> {
        Ok(self.engine.word_stop(expected, offset, direction)?)
    }
}

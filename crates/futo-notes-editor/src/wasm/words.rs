//! JSON wire facade for words: a double click's word and Option+Arrow's stop.
use super::*;
use crate::CaretDirection;

#[wasm_bindgen]
impl WasmSession {
    /// The word a double click at display byte `offset` selects, as a display range.
    pub fn word_at(&self, revision: u64, offset: usize) -> Result<String, JsValue> {
        json(
            &self
                .0
                .word_at(Revision(revision), DisplayOffset(offset))
                .map_err(error)?,
        )
    }

    /// Where Option+Arrow from display byte `offset` stops.
    pub fn word_stop(&self, revision: u64, offset: usize, forward: bool) -> Result<usize, JsValue> {
        let direction = if forward {
            CaretDirection::Forward
        } else {
            CaretDirection::Backward
        };
        Ok(self
            .0
            .word_stop(Revision(revision), DisplayOffset(offset), direction)
            .map_err(error)?
            .0)
    }
}

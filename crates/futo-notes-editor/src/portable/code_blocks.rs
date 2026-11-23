//! A code block as one object and its header. Selecting changes no source;
//! a header is ordinary input, sent to the worker like any edit.
use super::*;
use crate::{CodeBlockHeader, SelectionChange};

impl PortableSession {
    pub fn select_code_block(
        &mut self,
        expected: Revision,
        at: DisplayOffset,
    ) -> Result<SelectionChange, PortableError> {
        Ok(self.engine.select_code_block(expected, at)?)
    }

    /// The code block selected as one object: a key that only selects one
    /// returns no change, so a view reads it here, with `selection`.
    pub fn selected_block(&self) -> Option<DisplayRange> {
        self.engine.selected_block()
    }

    /// Whether the caret writes its code block's language. An input that
    /// changes no source returns no change, so a view reads it here.
    pub fn writes_language(&self) -> bool {
        self.engine.writes_language()
    }

    /// `None` when the block already has this header; `InvalidText` when it
    /// would not read back, and nothing changed.
    pub fn set_code_block_header(
        &mut self,
        expected: Revision,
        header: &CodeBlockHeader,
    ) -> Result<Option<Applied>, PortableError> {
        self.apply_input(|engine, accept| engine.set_code_block_header(expected, header, accept))
    }
}

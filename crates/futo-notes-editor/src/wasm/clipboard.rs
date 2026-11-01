//! JSON wire facade for plain Markdown copy, cut and paste.
use super::*;

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[wasm_bindgen]
impl WasmSession {
    pub fn copy_markdown(
        &self,
        revision: u64,
        start: usize,
        end: usize,
    ) -> Result<String, JsValue> {
        self.0
            .copy_markdown(Revision(revision), range(start, end))
            .map_err(error)
    }

    /// `[markdown, request-or-null]`.
    pub fn cut_markdown(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
    ) -> Result<String, JsValue> {
        json(
            &self
                .0
                .cut_markdown(Revision(revision), range(start, end))
                .map_err(error)?,
        )
    }

    pub fn paste_markdown(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        text: &str,
    ) -> Result<String, JsValue> {
        json(
            &self
                .0
                .paste_markdown(Revision(revision), range(start, end), text)
                .map_err(error)?,
        )
    }
}

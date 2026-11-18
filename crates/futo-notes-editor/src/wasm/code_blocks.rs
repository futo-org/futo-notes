//! JSON wire facade for a code block as one object and its header. Hosts ask
//! what a header field keeps of typed text and keep no rule of their own.
use super::*;

/// What a code block's language field keeps of `typed` (one word).
#[wasm_bindgen]
pub fn typed_code_block_language(typed: &str) -> String {
    crate::typed_code_block_language(typed)
}

/// What a code block's name field keeps of `typed`.
#[wasm_bindgen]
pub fn typed_code_block_name(typed: &str) -> String {
    crate::typed_code_block_name(typed)
}

#[wasm_bindgen]
impl WasmSession {
    /// `select_code_block`: the block whose code shows at display byte `at`.
    pub fn select_code_block(&mut self, revision: u64, at: usize) -> Result<String, JsValue> {
        json(
            &self
                .0
                .select_code_block(Revision(revision), DisplayOffset(at))
                .map_err(error)?,
        )
    }

    pub fn selected_block(&self) -> Result<String, JsValue> {
        json(&self.0.selected_block())
    }

    pub fn writes_language(&self) -> bool {
        self.0.writes_language()
    }

    /// `header` is a `CodeBlockHeader` as JSON (`{at, language, name}`).
    /// `{change, request}`, or null when the block already has it; throws
    /// `Editor(InvalidText)` when it would not read back.
    pub fn set_code_block_header(
        &mut self,
        revision: u64,
        header: &str,
    ) -> Result<String, JsValue> {
        let header = serde_json::from_str(header).map_err(error)?;
        json(
            &self
                .0
                .set_code_block_header(Revision(revision), &header)
                .map_err(error)?,
        )
    }
}

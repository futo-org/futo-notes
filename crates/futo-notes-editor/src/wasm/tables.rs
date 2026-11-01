//! JSON wire facade for table cells, structural commands and keys.
use super::*;
use crate::portable::PortableTableStep;

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[wasm_bindgen]
impl WasmSession {
    /// Table description or `null` when the range is not in a table.
    pub fn inspect_table(
        &self,
        revision: u64,
        start: usize,
        end: usize,
    ) -> Result<String, JsValue> {
        json(
            &self
                .0
                .inspect_table(Revision(revision), range(start, end))
                .map_err(error)?,
        )
    }

    pub fn inspect_table_utf16(
        &self,
        revision: u64,
        start: usize,
        end: usize,
    ) -> Result<String, JsValue> {
        json(
            &self
                .0
                .inspect_table_utf16(Revision(revision), utf16_range(start, end))
                .map_err(error)?,
        )
    }

    /// Request-or-null; `null` means the range is not in a table.
    pub fn replace_in_cell(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        inserted: &str,
    ) -> Result<String, JsValue> {
        json(
            &self
                .0
                .replace_in_cell(Revision(revision), range(start, end), inserted)
                .map_err(error)?,
        )
    }

    pub fn replace_in_cell_utf16(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        inserted: &[u16],
    ) -> Result<String, JsValue> {
        json(
            &self
                .0
                .replace_in_cell_utf16(Revision(revision), utf16_range(start, end), inserted)
                .map_err(error)?,
        )
    }

    /// `command` is a `TableCommand` name such as `"InsertRowBelow"`.
    pub fn table_command(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        command: &str,
    ) -> Result<String, JsValue> {
        let command = serde_json::from_str(&format!("{command:?}")).map_err(error)?;
        json(
            &self
                .0
                .table_command(Revision(revision), range(start, end), command)
                .map_err(error)?,
        )
    }

    pub fn table_command_utf16(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        command: &str,
    ) -> Result<String, JsValue> {
        let command = serde_json::from_str(&format!("{command:?}")).map_err(error)?;
        json(
            &self
                .0
                .table_command_utf16(Revision(revision), utf16_range(start, end), command)
                .map_err(error)?,
        )
    }

    /// `null`, `{"selected": change}` or `{"edited": request}`.
    pub fn table_key(&mut self, revision: u64, key: &str) -> Result<String, JsValue> {
        let key = serde_json::from_str(&format!("{key:?}")).map_err(error)?;
        json(
            &match self.0.table_key(Revision(revision), key).map_err(error)? {
                None => serde_json::Value::Null,
                Some(PortableTableStep::Selected(change)) => {
                    serde_json::json!({ "selected": change })
                }
                Some(PortableTableStep::Edited(request)) => {
                    serde_json::json!({ "edited": request })
                }
            },
        )
    }
}

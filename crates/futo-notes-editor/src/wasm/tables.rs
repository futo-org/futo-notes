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
    /// Whether the caret writes a table's delimiter row (draw the row only
    /// while it does).
    pub fn writes_delimiter_row(&self) -> bool {
        self.0.writes_delimiter_row()
    }

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
        table_step(self.0.table_key(Revision(revision), key).map_err(error)?)
    }

    /// Cell `column` of the header or body row at UTF-16 display offset
    /// `at`, given empty cells up to it when the row lacks it: as `table_key`
    /// returns (`null` off such a row or past the table's columns).
    pub fn enter_table_cell_utf16(
        &mut self,
        revision: u64,
        at: usize,
        column: usize,
    ) -> Result<String, JsValue> {
        table_step(
            self.0
                .enter_table_cell_utf16(Revision(revision), DisplayUtf16Offset(at), column)
                .map_err(error)?,
        )
    }
}

fn table_step(step: Option<PortableTableStep>) -> Result<String, JsValue> {
    json(&match step {
        None => serde_json::Value::Null,
        Some(PortableTableStep::Selected(change)) => serde_json::json!({ "selected": change }),
        Some(PortableTableStep::Edited(applied)) => serde_json::json!({ "edited": applied }),
    })
}

//! JSON wire facade; all persistence happens asynchronously in the native host.
use wasm_bindgen::prelude::*;

use crate::{
    DisplayOffset, DisplayRange, DisplayUtf16Offset, DisplayUtf16Range, PortableSession, Revision,
    SessionToken,
};

#[wasm_bindgen]
pub struct WasmSession(PortableSession);

fn error(error: impl std::fmt::Debug) -> JsValue {
    JsValue::from_str(&format!("{error:?}"))
}
fn json(value: &impl serde::Serialize) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(error)
}

fn validate_wire(token: u64, revision: u64, durable: u64) -> Result<(), JsValue> {
    if token > 9_007_199_254_740_991 || revision > 9_007_199_254_740_991 {
        return Err(error(
            "JSON wire integers must be exactly representable in JavaScript",
        ));
    }
    if durable > revision {
        return Err(error("invalid durable revision"));
    }
    Ok(())
}

#[wasm_bindgen]
impl WasmSession {
    #[wasm_bindgen(constructor)]
    pub fn new(
        token: u64,
        source: &str,
        revision: u64,
        durable: u64,
    ) -> Result<WasmSession, JsValue> {
        validate_wire(token, revision, durable)?;
        Ok(Self(PortableSession::open(
            SessionToken(token),
            source,
            Revision(revision),
            Revision(durable),
        )))
    }
    pub fn restore(snapshot: &str) -> Result<WasmSession, JsValue> {
        let snapshot: crate::HostSnapshot = serde_json::from_str(snapshot).map_err(error)?;
        // Reuse constructor validation for the JSON integer boundary.
        validate_wire(snapshot.token.0, snapshot.revision.0, snapshot.durable.0)?;
        Ok(Self(
            PortableSession::from_snapshot(snapshot).map_err(error)?,
        ))
    }

    pub fn project(&self, revision: u64, start: usize, end: usize) -> Result<String, JsValue> {
        json(
            &self
                .0
                .project(
                    Revision(revision),
                    DisplayRange {
                        start: DisplayOffset(start),
                        end: DisplayOffset(end),
                    },
                )
                .map_err(error)?,
        )
    }
    pub fn select_with_affinity(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        affinity: &str,
    ) -> Result<String, JsValue> {
        let affinity = serde_json::from_str(affinity).map_err(error)?;
        json(
            &self
                .0
                .select_with_affinity(
                    Revision(revision),
                    DisplayRange {
                        start: DisplayOffset(start),
                        end: DisplayOffset(end),
                    },
                    affinity,
                )
                .map_err(error)?,
        )
    }
    pub fn active_formats(&self) -> Result<String, JsValue> {
        json(&self.0.active_formats().map_err(error)?)
    }
    pub fn toggle_format(&mut self, revision: u64, format: &str) -> Result<String, JsValue> {
        let format = serde_json::from_str(format).map_err(error)?;
        json(
            &self
                .0
                .toggle_format(Revision(revision), format)
                .map_err(error)?,
        )
    }

    pub fn draft_text(&self) -> String {
        self.0.draft_text()
    }
    pub fn status(&self) -> Result<String, JsValue> {
        json(&self.0.status())
    }
    pub fn replace(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        inserted: &str,
    ) -> Result<String, JsValue> {
        json(
            &self
                .0
                .replace(
                    Revision(revision),
                    DisplayRange {
                        start: DisplayOffset(start),
                        end: DisplayOffset(end),
                    },
                    inserted,
                )
                .map_err(error)?,
        )
    }
    pub fn block_command_utf16(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        command: &str,
    ) -> Result<String, JsValue> {
        let command = serde_json::from_str(command).map_err(error)?;
        json(
            &self
                .0
                .block_command_utf16(
                    Revision(revision),
                    DisplayUtf16Range {
                        start: DisplayUtf16Offset(start),
                        end: DisplayUtf16Offset(end),
                    },
                    command,
                )
                .map_err(error)?,
        )
    }

    pub fn paragraph_key_utf16(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        key: &str,
    ) -> Result<String, JsValue> {
        let key = serde_json::from_str(key).map_err(error)?;
        json(
            &self
                .0
                .paragraph_key_utf16(
                    Revision(revision),
                    DisplayUtf16Range {
                        start: DisplayUtf16Offset(start),
                        end: DisplayUtf16Offset(end),
                    },
                    key,
                )
                .map_err(error)?,
        )
    }

    pub fn replace_utf16(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        inserted: &[u16],
    ) -> Result<String, JsValue> {
        json(
            &self
                .0
                .replace_utf16(
                    Revision(revision),
                    DisplayUtf16Range {
                        start: DisplayUtf16Offset(start),
                        end: DisplayUtf16Offset(end),
                    },
                    inserted,
                )
                .map_err(error)?,
        )
    }
    pub fn replace_utf16_action(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        inserted: &[u16],
        action: &str,
    ) -> Result<String, JsValue> {
        let action = serde_json::from_str(action).map_err(error)?;
        json(
            &self
                .0
                .replace_utf16_action(
                    Revision(revision),
                    DisplayUtf16Range {
                        start: DisplayUtf16Offset(start),
                        end: DisplayUtf16Offset(end),
                    },
                    inserted,
                    action,
                )
                .map_err(error)?,
        )
    }

    pub fn replace_many_utf16(
        &mut self,
        revision: u64,
        replacements: &str,
    ) -> Result<String, JsValue> {
        let replacements: Vec<crate::DisplayUtf16Replacement> =
            serde_json::from_str(replacements).map_err(error)?;
        json(
            &self
                .0
                .replace_many_utf16(Revision(revision), &replacements)
                .map_err(error)?,
        )
    }

    pub fn composition(&self) -> Result<String, JsValue> {
        json(&self.0.composition())
    }

    pub fn compose_utf16(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        text: &[u16],
    ) -> Result<String, JsValue> {
        json(
            &self
                .0
                .compose_utf16(
                    Revision(revision),
                    DisplayUtf16Range {
                        start: DisplayUtf16Offset(start),
                        end: DisplayUtf16Offset(end),
                    },
                    text,
                )
                .map_err(error)?,
        )
    }

    pub fn cancel_composition(&mut self, revision: u64) -> Result<(), JsValue> {
        self.0.cancel_composition(Revision(revision)).map_err(error)
    }

    pub fn commit_composition_utf16(
        &mut self,
        revision: u64,
        text: Option<Vec<u16>>,
    ) -> Result<String, JsValue> {
        json(
            &self
                .0
                .commit_composition_utf16(Revision(revision), text.as_deref())
                .map_err(error)?,
        )
    }

    pub fn replace_os_utf16(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        text: &[u16],
        placeholders: &str,
    ) -> Result<String, JsValue> {
        let placeholders: Vec<DisplayUtf16Range> =
            serde_json::from_str(placeholders).map_err(error)?;
        json(
            &self
                .0
                .replace_os_utf16(
                    Revision(revision),
                    DisplayUtf16Range {
                        start: DisplayUtf16Offset(start),
                        end: DisplayUtf16Offset(end),
                    },
                    text,
                    &placeholders,
                )
                .map_err(error)?,
        )
    }

    pub fn undo(&mut self, revision: u64) -> Result<String, JsValue> {
        json(&self.0.undo(Revision(revision)).map_err(error)?)
    }
    pub fn redo(&mut self, revision: u64) -> Result<String, JsValue> {
        json(&self.0.redo(Revision(revision)).map_err(error)?)
    }
    pub fn flush(&mut self) -> Result<String, JsValue> {
        json(&self.0.flush().map_err(error)?)
    }
    pub fn apply_relink_offer(&mut self) -> Result<String, JsValue> {
        json(&self.0.apply_relink_offer().map_err(error)?)
    }
    pub fn resume(&mut self) -> Result<String, JsValue> {
        json(&self.0.resume().map_err(error)?)
    }
    pub fn retry_pending(&mut self) -> Result<String, JsValue> {
        json(&self.0.retry_pending().map_err(error)?)
    }
    pub fn acknowledge(&mut self, acknowledgement: &str) -> Result<String, JsValue> {
        let ack = serde_json::from_str(acknowledgement).map_err(error)?;
        json(&self.0.acknowledge(ack).map_err(error)?)
    }
}

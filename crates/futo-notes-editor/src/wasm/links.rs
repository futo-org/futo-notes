//! JSON wire facade for links: inspecting and writing them, `[[` completion,
//! and what a destination means. Hosts ask these and keep no scheme list.
use super::*;

/// The address a tapped link `destination` opens outside the app, or
/// `undefined`: only `http`, `https`, `mailto`, `tel` and `sms` open.
#[wasm_bindgen]
pub fn external_link_url(destination: &str) -> Option<String> {
    crate::external_link_url(destination)
}

#[wasm_bindgen]
impl WasmSession {
    pub fn inspect_link(&self, revision: u64, start: usize, end: usize) -> Result<String, JsValue> {
        json(
            &self
                .0
                .inspect_link(
                    Revision(revision),
                    DisplayRange {
                        start: DisplayOffset(start),
                        end: DisplayOffset(end),
                    },
                )
                .map_err(error)?,
        )
    }
    pub fn link_label(&self, revision: u64, start: usize, end: usize) -> Result<String, JsValue> {
        json(
            &self
                .0
                .link_label(
                    Revision(revision),
                    DisplayRange {
                        start: DisplayOffset(start),
                        end: DisplayOffset(end),
                    },
                )
                .map_err(error)?,
        )
    }
    pub fn set_link(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        destination: &str,
    ) -> Result<String, JsValue> {
        json(
            &self
                .0
                .set_link(
                    Revision(revision),
                    DisplayRange {
                        start: DisplayOffset(start),
                        end: DisplayOffset(end),
                    },
                    destination,
                )
                .map_err(error)?,
        )
    }
    pub fn edit_link(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        label: &str,
        destination: &str,
    ) -> Result<String, JsValue> {
        json(
            &self
                .0
                .edit_link(
                    Revision(revision),
                    DisplayRange {
                        start: DisplayOffset(start),
                        end: DisplayOffset(end),
                    },
                    label,
                    destination,
                )
                .map_err(error)?,
        )
    }
    pub fn wikilink_completion(&self, revision: u64) -> Result<String, JsValue> {
        json(
            &self
                .0
                .wikilink_completion(Revision(revision))
                .map_err(error)?,
        )
    }
    pub fn accept_wikilink_completion(
        &mut self,
        revision: u64,
        start: usize,
        end: usize,
        query: &str,
        note_id: &str,
    ) -> Result<String, JsValue> {
        json(
            &self
                .0
                .accept_wikilink_completion(
                    Revision(revision),
                    DisplayRange {
                        start: DisplayOffset(start),
                        end: DisplayOffset(end),
                    },
                    query,
                    note_id,
                )
                .map_err(error)?,
        )
    }
    /// The note id a tapped schemeless link `destination` names, from the
    /// note `current_id`'s folder, or `undefined`.
    pub fn resolve_note_link(&self, current_id: &str, destination: &str) -> Option<String> {
        self.0.resolve_note_link(current_id, destination)
    }

    /// The destination the link prompt of the note `current_id` saves for
    /// `typed`.
    pub fn normalize_link_destination(&self, current_id: &str, typed: &str) -> String {
        self.0.normalize_link_destination(current_id, typed)
    }
}

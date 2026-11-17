//! Portable link operations: edits are ordinary input, inspection is a query.
use super::*;

impl PortableSession {
    pub fn inspect_link(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Option<crate::LinkDescription>, PortableError> {
        Ok(self.engine.inspect_link(expected, range)?)
    }

    pub fn set_link(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        destination: &str,
    ) -> Result<Option<Applied>, PortableError> {
        self.apply_input(|engine, accept| engine.set_link(expected, range, destination, accept))
    }

    pub fn edit_link(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        label: &str,
        destination: &str,
    ) -> Result<Option<Applied>, PortableError> {
        self.apply_input(|engine, accept| {
            engine.edit_link(expected, range, label, destination, accept)
        })
    }

    /// The note a tapped schemeless link `destination` names, among the
    /// delivered note ids, from the folder of the note `current_id`.
    pub fn resolve_note_link(&self, current_id: &str, destination: &str) -> Option<String> {
        self.engine.resolve_note_link(current_id, destination)
    }

    /// The destination the link prompt of the note `current_id` saves for
    /// `typed` (link_target.rs).
    pub fn normalize_link_destination(&self, current_id: &str, typed: &str) -> String {
        self.engine.normalize_link_destination(current_id, typed)
    }

    /// Note ids never append; like a query they never wait on acknowledgements.
    pub fn update_note_ids(
        &mut self,
        note_ids: &[String],
    ) -> Result<crate::NoteIdChange, PortableError> {
        Ok(self.engine.update_note_ids(note_ids))
    }
}

//! Link queries and commands remain canonical editor operations; the store
//! applies each edit in memory before returning the visible delta.
use super::*;
use futo_notes_editor::LinkDescription;

/// The ids `refresh_note_ids` delivers, read from the vault root.
pub(super) fn vault_note_ids(root: &std::path::Path) -> Vec<String> {
    crate::vault::note_order_and_folders(root, crate::NoteSortOrder::default()).0
}

impl StoreEditorSession<'_> {
    /// Deliver the vault's current note ids, read by the store itself, to the
    /// live engine. Nothing is appended; composition, selection and history stay.
    pub fn refresh_note_ids(
        &mut self,
    ) -> Result<futo_notes_editor::NoteIdChange, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Open)?;
        let ids = vault_note_ids(&self.store.root);
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        Ok(state.engine.update_note_ids(&ids))
    }

    /// The note a tapped schemeless link destination names, from this note's folder, among the
    /// ids delivered at open, at reset and on `refresh_note_ids`.
    pub fn resolve_note_link(&self, destination: &str) -> Result<Option<String>, EditorStoreError> {
        self.live(|state| {
            let id = state.id.clone();
            Ok(state.engine.resolve_note_link(&id, destination))
        })
    }

    pub fn inspect_link(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Option<LinkDescription>, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .inspect_link(expected, range)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn set_link(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        destination: &str,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.set_link(expected, range, destination))
    }
    pub fn edit_link(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        label: &str,
        destination: &str,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.edit_link(expected, range, label, destination))
    }
}

impl Attachment {
    pub fn set_link(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        destination: &str,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.edit(|engine, accept| engine.set_link(expected, range, destination, accept))
    }
    pub fn edit_link(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        label: &str,
        destination: &str,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.edit(|engine, accept| engine.edit_link(expected, range, label, destination, accept))
    }
}

impl StoreEditorSession<'_> {
    /// The open `[[` run at the caret and its candidates, from the note ids the
    /// store delivered at open, at reset and on `refresh_note_ids`.
    pub fn wikilink_completion(
        &self,
        expected: Revision,
    ) -> Result<Option<futo_notes_editor::WikilinkCompletion>, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .wikilink_completion(expected)
                .map_err(EditorStoreError::Editor)
        })
    }

    /// Accept one candidate as a single edit; stale claims change nothing.
    pub fn accept_wikilink_completion(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        query: &str,
        note_id: &str,
    ) -> Result<ViewChange, EditorStoreError> {
        self.live(|state| {
            state.edit(|engine, accept| {
                engine.accept_wikilink_completion(expected, range, query, note_id, accept)
            })
        })
    }
}

impl StoreEditorSession<'_> {
    /// Begin an asynchronous image insertion; the claim expires with this
    /// attachment (another note, or this note reopened).
    pub fn image_claim(&self) -> Result<futo_notes_editor::ImageClaim, EditorStoreError> {
        self.live(|state| Ok(state.engine.image_claim()))
    }

    /// Insert the stored vault reference as one edit. The store writes
    /// and cleans up asset files elsewhere; nothing here touches them.
    pub fn insert_image(
        &mut self,
        expected: Revision,
        claim: futo_notes_editor::ImageClaim,
        reference: &str,
        alt: &str,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| {
            state
                .edit(|engine, accept| engine.insert_image(expected, claim, reference, alt, accept))
        })
    }
}

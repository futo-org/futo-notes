//! Marked state is in-memory; only a final action edits the draft.
use super::*;
use futo_notes_editor::Composition;

impl StoreEditorSession<'_> {
    pub fn composition(&self) -> Option<Composition> {
        self.read(|state| state.engine.composition().cloned())
    }

    pub fn compose(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
    ) -> Result<Composition, EditorStoreError> {
        self.live(|state| state.compose(expected, range, text))
    }

    pub fn compose_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        text: &[u16],
    ) -> Result<Composition, EditorStoreError> {
        self.live(|state| state.compose_utf16(expected, range, text))
    }

    pub fn commit_composition_utf16(
        &mut self,
        expected: Revision,
        text: Option<&[u16]>,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.commit_composition_utf16(expected, text))
    }

    pub fn replace_os_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        text: &[u16],
        placeholders: &[DisplayUtf16Range],
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.replace_os_utf16(expected, range, text, placeholders))
    }

    pub fn cancel_composition(&mut self, expected: Revision) -> Result<(), EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .cancel_composition(expected)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn commit_composition(
        &mut self,
        expected: Revision,
        text: Option<&str>,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.commit_composition(expected, text))
    }

    pub fn replace_os(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        placeholders: &[DisplayRange],
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.replace_os(expected, range, text, placeholders))
    }
}

impl Attachment {
    pub fn compose(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
    ) -> Result<Composition, EditorStoreError> {
        self.input_ready()?;
        self.engine
            .compose(expected, range, text)
            .map_err(EditorStoreError::Editor)
    }

    pub fn compose_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        text: &[u16],
    ) -> Result<Composition, EditorStoreError> {
        self.input_ready()?;
        self.engine
            .compose_utf16(expected, range, text)
            .map_err(EditorStoreError::Editor)
    }

    pub fn commit_composition_utf16(
        &mut self,
        expected: Revision,
        text: Option<&[u16]>,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.edit(|engine, accept| engine.commit_composition_utf16(expected, text, accept))
    }

    pub fn replace_os_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        text: &[u16],
        placeholders: &[DisplayUtf16Range],
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.edit(|engine, accept| {
            engine.replace_os_utf16(expected, range, text, placeholders, accept)
        })
    }

    pub fn commit_composition(
        &mut self,
        expected: Revision,
        text: Option<&str>,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.edit(|engine, accept| engine.commit_composition(expected, text, accept))
    }

    pub fn replace_os(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        placeholders: &[DisplayRange],
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.edit(|engine, accept| engine.replace_os(expected, range, text, placeholders, accept))
    }
}

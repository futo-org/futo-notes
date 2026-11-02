//! Plain Markdown clipboard operations stay canonical editor operations; the
//! store applies cut and paste in memory. Copying reads the current projection,
//! so a deleted note's draft remains copyable.
use super::*;

impl StoreEditorSession<'_> {
    pub fn copy_markdown(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<String, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .copy_markdown(expected, range)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn cut_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<(String, Option<ViewChange>), EditorStoreError> {
        self.live(|state| state.edit(|engine, accept| engine.cut_markdown(expected, range, accept)))
    }

    pub fn paste_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| {
            state.edit(|engine, accept| engine.paste_markdown(expected, range, text, accept))
        })
    }
}

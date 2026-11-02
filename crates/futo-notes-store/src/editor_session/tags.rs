//! Tag queries and header-tag edits remain canonical editor operations; the
//! store applies each edit in memory before returning the delta.
use super::*;

impl StoreEditorSession<'_> {
    pub fn tags(&self) -> Result<Vec<String>, EditorStoreError> {
        self.live(|state| Ok(state.engine.tags()))
    }

    pub fn header_tags(&self) -> Result<Vec<String>, EditorStoreError> {
        self.live(|state| Ok(state.engine.header_tags()))
    }

    pub fn add_header_tag(
        &mut self,
        expected: Revision,
        tag: &str,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.edit_header_tag(expected, tag, true)
    }

    pub fn remove_header_tag(
        &mut self,
        expected: Revision,
        tag: &str,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.edit_header_tag(expected, tag, false)
    }

    fn edit_header_tag(
        &mut self,
        expected: Revision,
        tag: &str,
        add: bool,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| {
            state.edit(|engine, accept| {
                if add {
                    engine.add_header_tag(expected, tag, accept)
                } else {
                    engine.remove_header_tag(expected, tag, accept)
                }
            })
        })
    }
}

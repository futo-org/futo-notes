//! Tag queries and header-tag edits remain canonical editor operations; the
//! store supplies one guarded recovery acceptance before returning the delta.
use super::*;

impl StoreEditorSession<'_> {
    pub fn tags(&self) -> Result<Vec<String>, EditorStoreError> {
        self.live(|state| Ok(state.engine.full()?.tags()))
    }

    pub fn header_tags(&self) -> Result<Vec<String>, EditorStoreError> {
        self.live(|state| Ok(state.engine.full()?.header_tags()))
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
        self.mutate(|state, store| {
            state.input_ready()?;
            let Attachment {
                engine, recovery, ..
            } = state;
            let root = &store.root;
            let accept = &mut |edit: &futo_notes_editor::SourceEdit| recovery.append(root, edit);
            let session = engine.full_mut()?;
            let result = if add {
                session.add_header_tag(expected, tag, accept)
            } else {
                session.remove_header_tag(expected, tag, accept)
            };
            result.map_err(|error| match error {
                EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
                other => EditorStoreError::Editor(other),
            })
        })
    }
}

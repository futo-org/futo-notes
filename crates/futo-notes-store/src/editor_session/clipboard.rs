//! Plain Markdown clipboard operations stay canonical editor operations; the
//! store supplies one guarded recovery acceptance for cut and paste. Copying
//! reads the accepted projection, so a paused draft remains copyable.
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
        self.mutate(|state, store| {
            state.input_ready()?;
            let Attachment {
                engine, recovery, ..
            } = state;
            engine
                .cut_markdown(expected, range, &mut |edit| {
                    recovery.append(&store.root, edit)
                })
                .map_err(append_error)
        })
    }

    pub fn paste_markdown(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.mutate(|state, store| {
            state.input_ready()?;
            let Attachment {
                engine, recovery, ..
            } = state;
            engine
                .paste_markdown(expected, range, text, &mut |edit| {
                    recovery.append(&store.root, edit)
                })
                .map_err(append_error)
        })
    }
}

fn append_error(error: EditorError) -> EditorStoreError {
    match error {
        EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
        other => EditorStoreError::Editor(other),
    }
}

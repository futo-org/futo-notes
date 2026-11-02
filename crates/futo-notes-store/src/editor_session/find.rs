//! Find stays a canonical editor operation. It never edits the draft;
//! only stepping moves the selection, like any selection change.
use super::*;
use futo_notes_editor::{FindReport, FindScanRequest, FindScanResult};

impl StoreEditorSession<'_> {
    fn find_engine<T>(
        &self,
        operation: impl FnOnce(&mut EditorSession) -> Result<T, EditorError>,
    ) -> Result<T, EditorStoreError> {
        self.live(|state| operation(&mut state.engine).map_err(EditorStoreError::Editor))
    }

    pub fn find_set_query(
        &mut self,
        expected: Revision,
        query: &str,
    ) -> Result<FindReport, EditorStoreError> {
        self.find_engine(|engine| engine.find_set_query(expected, query))
    }

    pub fn find_step(
        &mut self,
        expected: Revision,
        direction: CaretDirection,
    ) -> Result<FindReport, EditorStoreError> {
        self.find_engine(|engine| engine.find_step(expected, direction))
    }

    pub fn find_close(&mut self) -> Result<FindReport, EditorStoreError> {
        self.find_engine(|engine| Ok(engine.find_close()))
    }

    pub fn find_report(&mut self) -> Result<FindReport, EditorStoreError> {
        self.find_engine(|engine| Ok(engine.find_report()))
    }

    pub fn find_matches(
        &mut self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<Vec<DisplayRange>, EditorStoreError> {
        self.find_engine(|engine| engine.find_matches(expected, range))
    }

    pub fn find_scan_request(&self) -> Result<Option<FindScanRequest>, EditorStoreError> {
        self.live(|state| Ok(state.engine.find_scan_request()))
    }

    /// `None` means the result was stale (other revision or query) and ignored.
    pub fn find_apply_scan(
        &mut self,
        result: &FindScanResult,
    ) -> Result<Option<FindReport>, EditorStoreError> {
        self.find_engine(|engine| Ok(engine.find_apply_scan(result)))
    }
}

use super::*;
use futo_notes_editor::{BoundedEditorSession, BoundedError, BoundedWork};

pub(super) enum EditorMode {
    Full(EditorSession),
    Bounded(BoundedEditorSession),
}

/// The attachment keeps one engine owner across consuming interface transfers.
/// None exists only while the attachment mutex is held during a transfer.
pub(super) struct EditorOwner(pub(super) Option<EditorMode>);

impl EditorOwner {
    pub(super) fn full(&self) -> Result<&EditorSession, EditorStoreError> {
        match self
            .0
            .as_ref()
            .expect("engine transfer holds the attachment lock")
        {
            EditorMode::Full(engine) => Ok(engine),
            EditorMode::Bounded(_) => Err(EditorStoreError::ModeResetRequired),
        }
    }
    pub(super) fn full_mut(&mut self) -> Result<&mut EditorSession, EditorStoreError> {
        match self
            .0
            .as_mut()
            .expect("engine transfer holds the attachment lock")
        {
            EditorMode::Full(engine) => Ok(engine),
            EditorMode::Bounded(_) => Err(EditorStoreError::ModeResetRequired),
        }
    }
    pub(super) fn bounded(&self) -> Result<&BoundedEditorSession, EditorStoreError> {
        match self
            .0
            .as_ref()
            .expect("engine transfer holds the attachment lock")
        {
            EditorMode::Bounded(engine) => Ok(engine),
            EditorMode::Full(_) => Err(EditorStoreError::ModeResetRequired),
        }
    }
    pub(super) fn bounded_mut(&mut self) -> Result<&mut BoundedEditorSession, EditorStoreError> {
        match self
            .0
            .as_mut()
            .expect("engine transfer holds the attachment lock")
        {
            EditorMode::Bounded(engine) => Ok(engine),
            EditorMode::Full(_) => Err(EditorStoreError::ModeResetRequired),
        }
    }
    pub(super) fn source_text(&self) -> String {
        match self.0.as_ref().unwrap() {
            EditorMode::Full(engine) => engine.source_text(),
            EditorMode::Bounded(engine) => engine.source_text(),
        }
    }
    pub(super) fn revision(&self) -> Revision {
        match self.0.as_ref().unwrap() {
            EditorMode::Full(engine) => engine.revision(),
            EditorMode::Bounded(engine) => engine.source_authority().revision,
        }
    }
    pub(super) fn display_text(&self) -> String {
        match self.0.as_ref().unwrap() {
            EditorMode::Full(engine) => engine.display_text(),
            EditorMode::Bounded(engine) => engine.display_text(),
        }
    }
    pub(super) fn materialize(&mut self) -> BoundedWork {
        let (mode, work) = match self.0.take().unwrap() {
            EditorMode::Full(engine) => (EditorMode::Full(engine), BoundedWork::default()),
            EditorMode::Bounded(engine) => {
                let (engine, work) = engine.materialize();
                (EditorMode::Full(engine), work)
            }
        };
        self.0 = Some(mode);
        work
    }
}

impl Attachment {
    /// Flush accepted bytes before proportional work, then retire bounded
    /// presentation authority before any subsequent fallible coordination.
    pub(super) fn materializing_reset(
        &mut self,
        root: &std::path::Path,
    ) -> Result<BoundedWork, String> {
        if self.engine.full().is_ok() {
            return Ok(BoundedWork::default());
        }
        if self.recovery.failed {
            return Err("editor recovery must settle before materialization".into());
        }
        self.recovery.flush(root)?;
        let work = self.engine.materialize();
        self.recovery.cancel_bounded_preparation(root)?;
        Ok(work)
    }
}

pub(super) fn bounded_error(error: BoundedError) -> EditorStoreError {
    match error {
        BoundedError::Editor(EditorError::Persistence(error)) => {
            EditorStoreError::RecoveryAppend(error)
        }
        error => EditorStoreError::Bounded(error),
    }
}

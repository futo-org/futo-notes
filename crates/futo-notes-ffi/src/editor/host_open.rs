//! What a view needs while a long note opens: the quick first screens with their spans, and the
//! input it takes before the engine session exists (`futo_notes_editor::host`).
use std::sync::{Arc, Mutex};

use futo_notes_editor::host::{plan_quick_open, PendingEdits};

use super::host::{EditorMirrorError, EditorStyleSpan};
use super::EditorUtf16Range;

fn index(value: u64) -> Result<usize, EditorMirrorError> {
    usize::try_from(value).map_err(|_| EditorMirrorError::OutOfRange)
}

/// A long note's quick first screens with their spans, in UTF-16 units of the display text
/// (`NoteStore.quick_open_view`): what a host shows read-only before its session exists.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EditorQuickView {
    pub display: String,
    pub spans: Vec<EditorStyleSpan>,
}

impl From<futo_notes_editor::QuickOpen> for EditorQuickView {
    fn from(quick: futo_notes_editor::QuickOpen) -> Self {
        let spans = plan_quick_open(&quick)
            .into_iter()
            .map(Into::into)
            .collect();
        Self {
            display: quick.display,
            spans,
        }
    }
}

/// Edits and selections a view takes while its engine session does not exist yet, mapped to the
/// engine's coordinates in the order they will replay (see `host::PendingEdits`).
#[derive(uniffi::Object)]
pub struct EditorPendingEdits {
    inner: Mutex<PendingEdits>,
}

#[uniffi::export]
impl EditorPendingEdits {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(PendingEdits::new()),
        })
    }

    /// Queue an edit made on the text the user sees; the range to replay it on.
    pub fn push(
        &self,
        start: u64,
        end: u64,
        inserted_utf16: u64,
    ) -> Result<EditorUtf16Range, EditorMirrorError> {
        let (start, end, inserted) = (index(start)?, index(end)?, index(inserted_utf16)?);
        let (start, end) = self.with(|p| p.push(start, end, inserted));
        Ok(EditorUtf16Range {
            start: start as u64,
            end: end as u64,
        })
    }

    /// Note an edit the engine made while replaying, in the coordinates of the text before it:
    /// the `EditorMirrorEdit`, `slack_utf16` its `slack_utf16`, and `near` the start of the range
    /// it was replayed at (the spelling of an edit inside a run of identical characters nearest
    /// `near` is the one recorded).
    pub fn record(
        &self,
        start: u64,
        end: u64,
        inserted_utf16: u64,
        slack_utf16: u64,
        near: u64,
    ) -> Result<(), EditorMirrorError> {
        let (start, end, inserted) = (index(start)?, index(end)?, index(inserted_utf16)?);
        let (slack, near) = (index(slack_utf16)?, index(near)?);
        self.with(|p| p.record_near(start, end, inserted, slack, near));
        Ok(())
    }

    /// A range of the text the user sees, as the engine holds it after every recorded edit.
    pub fn map(&self, start: u64, end: u64) -> Result<EditorUtf16Range, EditorMirrorError> {
        let (start, end) = (index(start)?, index(end)?);
        let (start, end) = self.with(|p| p.map(start, end));
        Ok(EditorUtf16Range {
            start: start as u64,
            end: end as u64,
        })
    }

    pub fn count(&self) -> u64 {
        self.with(|p| p.len() as u64)
    }

    pub fn clear(&self) {
        self.with(|p| p.clear())
    }
}

impl EditorPendingEdits {
    fn with<T>(&self, f: impl FnOnce(&mut PendingEdits) -> T) -> T {
        f(&mut self.inner.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

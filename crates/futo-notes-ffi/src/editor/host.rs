//! Renderer-side helpers over `futo_notes_editor::host`: no Markdown rules, only
//! coordinates a native text view needs. Shaped to be adopted unchanged by
//! Android and iOS hosts.
use std::sync::{Arc, Mutex};

use futo_notes_editor::host::{DisplayMirror, MirrorEdit, MirrorError};

/// A coordinate the mirror refused; nothing changed.
#[derive(Debug, uniffi::Error, thiserror::Error)]
pub enum EditorMirrorError {
    #[error("offset outside the display text")]
    OutOfRange,
    #[error("offset splits a character")]
    SplitCharacter,
    #[error("range start is after its end")]
    Reversed,
}

impl From<MirrorError> for EditorMirrorError {
    fn from(value: MirrorError) -> Self {
        match value {
            MirrorError::OutOfRange => Self::OutOfRange,
            MirrorError::SplitCharacter => Self::SplitCharacter,
            MirrorError::Reversed => Self::Reversed,
        }
    }
}

/// One engine change in the host's UTF-16 units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct EditorMirrorEdit {
    /// The replaced range of the previous display.
    pub start: u64,
    pub end: u64,
    pub inserted_utf16: u64,
    /// The resulting selection in the new display.
    pub selection_start: u64,
    pub selection_end: u64,
}

impl From<MirrorEdit> for EditorMirrorEdit {
    fn from(value: MirrorEdit) -> Self {
        Self {
            start: value.start as u64,
            end: value.end as u64,
            inserted_utf16: value.inserted_utf16 as u64,
            selection_start: value.selection_start as u64,
            selection_end: value.selection_end as u64,
        }
    }
}

fn index(value: u64) -> Result<usize, EditorMirrorError> {
    usize::try_from(value).map_err(|_| EditorMirrorError::OutOfRange)
}

/// The host's copy of the engine's display text. Apply every `EditorViewChange`
/// to it, in order; it converts the change and selection to UTF-16 so the host
/// never scans text for offsets.
#[derive(uniffi::Object)]
pub struct EditorDisplayMirror {
    inner: Mutex<DisplayMirror>,
}

impl EditorDisplayMirror {
    fn with<T>(&self, f: impl FnOnce(&mut DisplayMirror) -> T) -> T {
        f(&mut self.inner.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

#[uniffi::export]
impl EditorDisplayMirror {
    #[uniffi::constructor]
    pub fn new(display: String) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(DisplayMirror::new(&display)),
        })
    }

    pub fn reset(&self, display: String) {
        self.with(|m| m.reset(&display))
    }

    pub fn text(&self) -> String {
        self.with(|m| m.text())
    }

    pub fn utf16_len(&self) -> u64 {
        self.with(|m| m.utf16_len() as u64)
    }

    pub fn byte_len(&self) -> u64 {
        self.with(|m| m.byte_len() as u64)
    }

    pub fn byte_to_utf16(&self, byte: u64) -> Result<u64, EditorMirrorError> {
        let byte = index(byte)?;
        Ok(self.with(|m| m.byte_to_utf16(byte))? as u64)
    }

    pub fn utf16_to_byte(&self, unit: u64) -> Result<u64, EditorMirrorError> {
        let unit = index(unit)?;
        Ok(self.with(|m| m.utf16_to_byte(unit))? as u64)
    }

    pub fn slice_utf16(&self, start: u64, end: u64) -> Result<String, EditorMirrorError> {
        let (start, end) = (index(start)?, index(end)?);
        Ok(self.with(|m| m.slice_utf16(start, end))?)
    }

    /// Apply `EditorViewChange { range, inserted, selection }`.
    pub fn apply_change(
        &self,
        start: u64,
        end: u64,
        inserted: String,
        selection_start: u64,
        selection_end: u64,
    ) -> Result<EditorMirrorEdit, EditorMirrorError> {
        let (start, end) = (index(start)?, index(end)?);
        let selection = (index(selection_start)?, index(selection_end)?);
        Ok(self
            .with(|m| m.apply_change(start, end, &inserted, selection))?
            .into())
    }
}

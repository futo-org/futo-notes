//! The first screens of a long note before its editor session exists
//! (`futo_notes_editor::quick_open`). Read-only: it takes no lease and writes
//! nothing, so a host may run it before, or beside, `open_editor`.
//!
//! A host that shows the first screens and then attaches a session takes both
//! from one [`EditorNoteRead`]: input made on the first screens then always
//! applies to the text it was made on, and an outside write that lands after
//! the read is the session's to merge or park when it saves (#392).
use futo_notes_editor::{may_define_reference, QuickOpen, QUICK_OPEN_BYTES};

use super::EditorStoreError;
use crate::{paths, LocalNoteStore, NOTE_NOT_FOUND};

/// A note's exact bytes, read once for its editor: its first screens
/// ([`LocalNoteStore::quick_open_read`]) and its session
/// ([`LocalNoteStore::open_editor_read`]) both come from them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorNoteRead {
    pub(super) id: String,
    pub(super) source: String,
}

impl EditorNoteRead {
    pub fn id(&self) -> &str {
        &self.id
    }
}

impl LocalNoteStore {
    /// Read a note for its editor; a missing note fails as its open would.
    pub fn read_for_editor(&self, id: &str) -> Result<EditorNoteRead, EditorStoreError> {
        paths::note_path(&self.root, id).map_err(EditorStoreError::Open)?;
        let source = self
            .read_existing(id)
            .map_err(EditorStoreError::Open)?
            .ok_or_else(|| EditorStoreError::Open(NOTE_NOT_FOUND.to_owned()))?;
        Ok(EditorNoteRead {
            id: id.to_owned(),
            source,
        })
    }

    /// The note's first screens, exactly as its editor session will show them,
    /// from its first [`QUICK_OPEN_BYTES`]. `None` when the note is no longer
    /// than that (its whole open is as quick), missing, or no cut stands.
    pub fn quick_open_editor(&self, id: &str) -> Result<Option<QuickOpen>, String> {
        match self.read_for_editor(id) {
            Ok(read) => Ok(self.quick_open_read(&read)),
            Err(EditorStoreError::Open(error)) if error == NOTE_NOT_FOUND => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    /// [`Self::quick_open_editor`] of the bytes `read` holds.
    pub fn quick_open_read(&self, read: &EditorNoteRead) -> Option<QuickOpen> {
        let source = &read.source;
        if source.len() <= QUICK_OPEN_BYTES {
            return None;
        }
        // A character cut by the read is left out of the head.
        let mut end = QUICK_OPEN_BYTES;
        while !source.is_char_boundary(end) {
            end -= 1;
        }
        let head = &source[..end];
        // From the head's last byte, so a `]:` across the seam is seen.
        let rest = &source.as_bytes()[end.saturating_sub(1)..];
        futo_notes_editor::quick_open(
            head,
            || may_define_reference(rest),
            || super::links::vault_note_ids(&self.root),
        )
    }
}

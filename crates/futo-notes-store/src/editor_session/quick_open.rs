//! The first screens of a long note before its editor session exists
//! (`futo_notes_editor::quick_open`). Read-only: it takes no lease and writes
//! nothing, so a host may run it before, or beside, `open_editor`.
//!
//! A host that shows the first screens and then attaches a session takes both
//! from one [`EditorNoteRead`]: input made on the first screens then always
//! applies to the text it was made on, and an outside write that lands after
//! the read is the session's to merge or park when it saves (#392).
use std::sync::atomic::{AtomicBool, Ordering};

use futo_notes_editor::{QuickOpen, QUICK_OPEN_BYTES};

use crate::{paths, LocalNoteStore};

/// A note's exact bytes, read once for its editor: its first screens
/// ([`LocalNoteStore::quick_open_read`]) come from them, and so does its
/// session ([`LocalNoteStore::open_editor_read`]) once they were shown.
#[derive(Debug)]
pub struct EditorNoteRead {
    pub(super) id: String,
    /// `None` when the read failed: the session's own read then decides.
    source: Option<String>,
    /// First screens were taken from `source`.
    shown: AtomicBool,
}

impl EditorNoteRead {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// What the session opens on in place of the file: the bytes its first
    /// screens showed, if any were.
    pub(super) fn shown(&self) -> Option<&str> {
        self.source
            .as_deref()
            .filter(|_| self.shown.load(Ordering::Acquire))
    }
}

impl LocalNoteStore {
    /// Read a note for its editor. Never fails: a note that cannot be read
    /// has no first screens, and its open reports why.
    pub fn read_for_editor(&self, id: &str) -> EditorNoteRead {
        EditorNoteRead {
            id: id.to_owned(),
            source: self.read_existing(id).ok().flatten(),
            shown: AtomicBool::new(false),
        }
    }

    /// The note's first screens, exactly as its editor session will show them,
    /// from its first [`QUICK_OPEN_BYTES`]. `None` when the note is no longer
    /// than that (its whole open is as quick), missing, or no cut stands.
    pub fn quick_open_editor(&self, id: &str) -> Result<Option<QuickOpen>, String> {
        paths::note_path(&self.root, id)?;
        Ok(self.quick_open_read(&self.read_for_editor(id)))
    }

    /// [`Self::quick_open_editor`] of the bytes `read` holds.
    /// Taking them marks the read as shown.
    pub fn quick_open_read(&self, read: &EditorNoteRead) -> Option<QuickOpen> {
        let source = read.source.as_deref()?;
        if source.len() <= QUICK_OPEN_BYTES {
            return None;
        }
        // A character cut by the read is left out of the head.
        let mut end = QUICK_OPEN_BYTES;
        while !source.is_char_boundary(end) {
            end -= 1;
        }
        let head = &source[..end];
        let quick =
            futo_notes_editor::quick_open(head, || super::links::vault_note_ids(&self.root));
        if quick.is_some() {
            read.shown.store(true, Ordering::Release);
        }
        quick
    }
}

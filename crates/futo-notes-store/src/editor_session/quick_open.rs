//! The first screens of a long note before its editor session exists
//! (`futo_notes_editor::quick_open`). Read-only: it takes no lease and writes
//! nothing, so a host may run it before, or beside, `open_editor`.
use std::io::Read;

use futo_notes_editor::{may_define_reference, QuickOpen, QUICK_OPEN_BYTES};

use crate::{note_filename, paths, LocalNoteStore};

/// How much of the rest of a note one read takes while looking for a definition.
const SCAN_BYTES: usize = 64 * 1024;

impl LocalNoteStore {
    /// The note's first screens, exactly as its editor session will show them,
    /// from its first [`QUICK_OPEN_BYTES`]. `None` when the note is no longer
    /// than that (its whole open is as quick) or no cut stands.
    pub fn quick_open_editor(&self, id: &str) -> Result<Option<QuickOpen>, String> {
        paths::note_path(&self.root, id)?;
        let Some(mut file) =
            futo_notes_core::files::vault_fs::open_optional(&self.root, &note_filename(id))?
        else {
            return Ok(None);
        };
        let mut read = Vec::with_capacity(QUICK_OPEN_BYTES + 1);
        (&mut file)
            .take(QUICK_OPEN_BYTES as u64 + 1)
            .read_to_end(&mut read)
            .map_err(|error| error.to_string())?;
        if read.len() <= QUICK_OPEN_BYTES {
            return Ok(None);
        }
        let head = match std::str::from_utf8(&read[..QUICK_OPEN_BYTES]) {
            Ok(head) => head,
            // A character cut by the read; anything else fails the whole open.
            Err(error) if error.error_len().is_none() => {
                std::str::from_utf8(&read[..error.valid_up_to()]).unwrap_or_default()
            }
            Err(_) => return Ok(None),
        };
        // From the head's last byte, so a `]:` across the seam is seen.
        let carried = &read[head.len().saturating_sub(1)..];
        let mut failed = None;
        let opened = futo_notes_editor::quick_open(
            head,
            || match rest_may_define(&mut file, carried) {
                Ok(found) => found,
                Err(error) => {
                    failed = Some(error);
                    true
                }
            },
            || super::links::vault_note_ids(&self.root),
        );
        match failed {
            Some(error) => Err(error),
            None => Ok(opened),
        }
    }
}

/// Whether `carried` and the rest of `file` after it may hold a definition.
fn rest_may_define(file: &mut std::fs::File, carried: &[u8]) -> Result<bool, String> {
    if may_define_reference(carried) {
        return Ok(true);
    }
    let mut buffer = vec![0; SCAN_BYTES + 1];
    let mut carried = match carried.last() {
        Some(&byte) => {
            buffer[0] = byte;
            1
        }
        None => 0,
    };
    loop {
        let read = file
            .read(&mut buffer[carried..])
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(false);
        }
        let filled = carried + read;
        if may_define_reference(&buffer[..filled]) {
            return Ok(true);
        }
        buffer[0] = buffer[filled - 1];
        carried = 1;
    }
}

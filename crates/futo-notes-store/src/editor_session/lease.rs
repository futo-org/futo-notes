use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};

use futo_notes_core::files::collision_key;

use super::EditorStoreError;

type SessionKey = (PathBuf, String);
static SESSIONS: OnceLock<Mutex<HashSet<SessionKey>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashSet<SessionKey>> {
    SESSIONS.get_or_init(Mutex::default)
}

/// The store's gate serializes mutations, while this process-wide lease also
/// excludes a second store handle from attaching to the same recovery stream.
pub(super) struct EditorLease(SessionKey);

impl EditorLease {
    pub(super) fn acquire(root: &Path, id: &str) -> Result<Self, EditorStoreError> {
        let key = (
            root.canonicalize()
                .map_err(|error| EditorStoreError::Open(error.to_string()))?,
            collision_key(id),
        );
        if !sessions()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key.clone())
        {
            return Err(EditorStoreError::SessionAlreadyOpen);
        }
        Ok(Self(key))
    }
}

impl Drop for EditorLease {
    fn drop(&mut self) {
        sessions()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.0);
    }
}

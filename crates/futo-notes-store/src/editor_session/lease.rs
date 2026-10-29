use super::{Attachment, EditorStoreError};
use futo_notes_core::files::collision_key;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, Weak};

type SessionKey = (PathBuf, String);
type Owner = Weak<Mutex<Attachment>>;
static SESSIONS: OnceLock<Mutex<HashMap<SessionKey, Owner>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<SessionKey, Owner>> {
    SESSIONS.get_or_init(Mutex::default)
}
fn key(root: &Path, id: &str) -> Result<SessionKey, EditorStoreError> {
    Ok((
        root.canonicalize()
            .map_err(|error| EditorStoreError::Open(error.to_string()))?,
        collision_key(id),
    ))
}

/// Registry lookup never holds the registry lock while locking an attachment.
/// A lease reserves its collision key even before its state has been bound.
pub(super) struct EditorLease(SessionKey, bool);
impl EditorLease {
    pub(super) fn acquire(root: &Path, id: &str) -> Result<Self, EditorStoreError> {
        let key = key(root, id)?;
        let mut entries = sessions().lock().unwrap_or_else(PoisonError::into_inner);
        if entries.contains_key(&key) {
            return Err(EditorStoreError::SessionAlreadyOpen);
        }
        entries.insert(key.clone(), Weak::new());
        Ok(Self(key, true))
    }
    pub(super) fn release(&mut self) {
        if self.1 {
            sessions()
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&self.0);
            self.1 = false;
        }
    }
    pub(super) fn bind(&self, state: &Arc<Mutex<Attachment>>) {
        sessions()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(self.0.clone(), Arc::downgrade(state));
    }
    pub(super) fn attached(
        root: &Path,
        id: &str,
    ) -> Result<Option<Arc<Mutex<Attachment>>>, String> {
        let key = key(root, id).map_err(|error| error.to_string())?;
        Ok(sessions()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key)
            .and_then(Weak::upgrade))
    }
}
impl Drop for EditorLease {
    fn drop(&mut self) {
        self.release();
    }
}

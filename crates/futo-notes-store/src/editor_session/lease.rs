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
    pub(super) fn deleting_owner(
        root: &Path,
        id: &str,
    ) -> Result<Option<Arc<Mutex<Attachment>>>, String> {
        Ok(Self::deleting_owners(root, id)?.into_iter().next())
    }
    pub(super) fn deleting_owners(
        root: &Path,
        id: &str,
    ) -> Result<Vec<Arc<Mutex<Attachment>>>, String> {
        let (root, _) = key(root, id).map_err(|error| error.to_string())?;
        let owners: Vec<_> = sessions()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter(|((vault, _), _)| vault == &root)
            .filter_map(|(_, owner)| owner.upgrade())
            .collect();
        // No registry mutex is held while examining an attachment. A foreign
        // destination recovery remains independently attachable while the
        // source's pending transition still participates in deletion.
        let mut matching = Vec::new();
        for owner in owners {
            let state = owner.lock().unwrap_or_else(PoisonError::into_inner);
            let matches = collision_key(&state.id) == collision_key(id)
                || state
                    .pending_identity
                    .as_ref()
                    .is_some_and(|pending| pending.targets(id));
            drop(state);
            if matches && !matching.iter().any(|entry| Arc::ptr_eq(entry, &owner)) {
                matching.push(owner);
            }
        }
        Ok(matching)
    }
}
impl Drop for EditorLease {
    fn drop(&mut self) {
        self.release();
    }
}

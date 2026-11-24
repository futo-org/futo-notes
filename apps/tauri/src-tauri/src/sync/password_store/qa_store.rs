//! The debug-only, in-memory `SecretStore` behind `FUTO_QA_EPHEMERAL_SECRETS=1`
//! (see the module doc in `super`). Nothing here is compiled into a release
//! build, so no environment variable can select it there.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::sync::Mutex;

use super::SecretStore;

/// Set to `1` on a debug build to keep sync secrets in process memory instead of
/// the OS keyring (QA launches set it; see the desktop QA playbook).
#[cfg(debug_assertions)]
const QA_EPHEMERAL_ENV: &str = "FUTO_QA_EPHEMERAL_SECRETS";

/// A process-lifetime map in memory, never persisted. Tests also use it as their
/// fake `SecretStore`.
#[derive(Default)]
pub(super) struct MemoryStore(Mutex<HashMap<String, String>>);

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .insert(account.to_owned(), secret.to_owned());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Backend {
    Keyring,
    /// Does not exist in release builds: there is nothing to enable there.
    #[cfg(debug_assertions)]
    Memory,
}

/// Which store a process uses, given the value of `FUTO_QA_EPHEMERAL_SECRETS`.
/// Release builds always answer [`Backend::Keyring`].
fn select_backend(qa_ephemeral: Option<&OsStr>) -> Backend {
    #[cfg(debug_assertions)]
    if qa_ephemeral == Some(OsStr::new("1")) {
        return Backend::Memory;
    }
    #[cfg(not(debug_assertions))]
    let _ = qa_ephemeral;
    Backend::Keyring
}

/// The shared in-memory store when this process opted in, else `None` (use the
/// keyring).
#[cfg(debug_assertions)]
pub(super) fn from_env() -> Option<&'static dyn SecretStore> {
    use std::sync::OnceLock;
    static QA_STORE: OnceLock<MemoryStore> = OnceLock::new();
    let requested = std::env::var_os(QA_EPHEMERAL_ENV);
    if select_backend(requested.as_deref()) != Backend::Memory {
        return None;
    }
    Some(QA_STORE.get_or_init(|| {
        futo_notes_core::log_to_stderr!(
            "[secrets] {QA_EPHEMERAL_ENV}=1: sync secrets are held in memory for this \
             process only (debug build); the OS keyring is not used"
        );
        MemoryStore::default()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_opt_in_means_the_os_keyring() {
        assert_eq!(select_backend(None), Backend::Keyring);
        assert_eq!(select_backend(Some(OsStr::new(""))), Backend::Keyring);
        assert_eq!(select_backend(Some(OsStr::new("0"))), Backend::Keyring);
        assert_eq!(select_backend(Some(OsStr::new("true"))), Backend::Keyring);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_debug_build_with_the_opt_in_uses_the_memory_store() {
        assert_eq!(select_backend(Some(OsStr::new("1"))), Backend::Memory);
    }

    // In a release build `Backend::Memory` does not exist, so the opt-in cannot
    // select it; run with `cargo test --release` to exercise this.
    #[cfg(not(debug_assertions))]
    #[test]
    fn a_release_build_ignores_the_opt_in() {
        assert_eq!(select_backend(Some(OsStr::new("1"))), Backend::Keyring);
    }
}

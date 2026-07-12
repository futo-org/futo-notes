//! OS-keyring-backed storage for the E2EE vault password.
//!
//! The vault password used to live in plaintext inside `.app-state.json`
//! under the notes root (F6), so any vault backup / Syncthing / Dropbox /
//! `git init` of the notes directory leaked it. It now lives in the OS
//! secret store — Secret Service on Linux, Keychain on macOS, Credential
//! Manager on Windows — mirroring the native shells (iOS Keychain / Android
//! Keystore). Nothing here ever falls back to writing the secret to disk;
//! when the OS store is unavailable the commands return an error and the JS
//! layer degrades to prompting for the password per session.
//!
//! The password is scoped per vault: the keyring *account* is the canonical
//! notes-root path, so the debug (`fake-notes`) and production
//! (`futo-notes`) vaults — and any `FUTO_NOTES_DATA_DIR` worktree — keep
//! independent entries, exactly like the old per-`.app-state.json` scoping.

use std::path::Path;

use tauri::AppHandle;

use crate::background_tasks::blocking;

const KEYRING_SERVICE: &str = "FUTO Notes E2EE sync";

/// Abstracts the OS secret store so the command logic is testable without a
/// live Secret Service / Keychain (see the `#[cfg(test)]` module).
trait SecretStore {
    /// `Ok(None)` — not an error — when no entry exists for `account`.
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    /// Idempotent: deleting a missing entry succeeds.
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// The real OS-keyring adapter.
struct KeyringStore;

impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new(KEYRING_SERVICE, account)
            .map_err(|e| e.to_string())?
            .set_password(secret)
            .map_err(|e| e.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

fn account_for(root: &Path) -> String {
    root.to_string_lossy().into_owned()
}

// Pure command bodies: derive the per-vault account and hit the store. Tested
// directly against an in-memory `SecretStore` in the `#[cfg(test)]` module.

fn get_impl(store: &dyn SecretStore, root: &Path) -> Result<Option<String>, String> {
    store.get(&account_for(root))
}

fn set_impl(store: &dyn SecretStore, root: &Path, secret: &str) -> Result<(), String> {
    store.set(&account_for(root), secret)
}

fn delete_impl(store: &dyn SecretStore, root: &Path) -> Result<(), String> {
    store.delete(&account_for(root))
}

#[tauri::command]
pub async fn e2ee_password_get(app: AppHandle) -> Result<Option<String>, String> {
    let root = crate::vault_location::root(&app)?;
    blocking(move || get_impl(&KeyringStore, &root)).await
}

#[tauri::command]
pub async fn e2ee_password_set(app: AppHandle, password: String) -> Result<(), String> {
    let root = crate::vault_location::root(&app)?;
    blocking(move || set_impl(&KeyringStore, &root, &password)).await
}

#[tauri::command]
pub async fn e2ee_password_delete(app: AppHandle) -> Result<(), String> {
    let root = crate::vault_location::root(&app)?;
    blocking(move || delete_impl(&KeyringStore, &root)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemStore(Mutex<HashMap<String, String>>);

    impl SecretStore for MemStore {
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

    #[test]
    fn get_missing_is_none_not_error() {
        let store = MemStore::default();
        assert_eq!(get_impl(&store, Path::new("/vault")).unwrap(), None);
    }

    #[test]
    fn set_then_get_roundtrips() {
        let store = MemStore::default();
        set_impl(&store, Path::new("/vault"), "hunter2").unwrap();
        assert_eq!(
            get_impl(&store, Path::new("/vault")).unwrap(),
            Some("hunter2".to_owned())
        );
    }

    #[test]
    fn delete_clears_and_is_idempotent() {
        let store = MemStore::default();
        set_impl(&store, Path::new("/vault"), "hunter2").unwrap();
        delete_impl(&store, Path::new("/vault")).unwrap();
        assert_eq!(get_impl(&store, Path::new("/vault")).unwrap(), None);
        // Deleting again (no entry) must not error.
        delete_impl(&store, Path::new("/vault")).unwrap();
    }

    // Exercises the REAL OS keyring backend end-to-end. `#[ignore]` so the
    // normal/CI test run never touches the live Secret Service / Keychain —
    // run it by hand on a machine with a secret store:
    //   cargo test -p futo-notes-tauri -- --ignored keyring_backend_roundtrips
    // Uses a unique account and deletes it, so it leaves no residue.
    #[test]
    #[ignore = "touches the real OS secret store"]
    fn keyring_backend_roundtrips_and_cleans_up() {
        let account = format!(
            "futo-notes-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let store = KeyringStore;
        assert_eq!(store.get(&account).unwrap(), None, "clean start");
        store.set(&account, "roundtrip-secret").unwrap();
        assert_eq!(
            store.get(&account).unwrap(),
            Some("roundtrip-secret".to_owned())
        );
        store.delete(&account).unwrap();
        assert_eq!(store.get(&account).unwrap(), None, "cleaned up");
        // Idempotent delete of a now-missing entry.
        store.delete(&account).unwrap();
    }

    #[test]
    fn distinct_vault_roots_do_not_share_a_secret() {
        // Guards the debug/production data-safety split (M3): the dev
        // `fake-notes` vault and the prod `futo-notes` vault get separate
        // keyring entries because the account is the notes-root path.
        let store = MemStore::default();
        set_impl(&store, Path::new("/home/u/Documents/fake-notes"), "dev-pw").unwrap();
        assert_eq!(
            get_impl(&store, Path::new("/home/u/Documents/futo-notes")).unwrap(),
            None
        );
        assert_eq!(
            get_impl(&store, Path::new("/home/u/Documents/fake-notes")).unwrap(),
            Some("dev-pw".to_owned())
        );
    }
}

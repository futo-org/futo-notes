//! OS-keyring-backed storage for this device's E2EE sync secrets: the vault
//! password, the 32-byte vault key, and the session token.
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
//! Every secret is scoped per vault: the keyring *account* is built from the
//! canonical notes-root path, so the debug (`fake-notes`) and production
//! (`futo-notes`) vaults — and any `FUTO_NOTES_DATA_DIR` worktree — keep
//! independent entries, exactly like the old per-`.app-state.json` scoping.
//! The password's account is the bare path and stays that way, so entries
//! written by earlier versions keep resolving; the key and the token prefix it.
//!
//! The vault key and session token have no caller yet. They exist because the
//! hosted flow holds a vault key instead of a password (ADR 0003), and the
//! shells that will read them — iOS `Keychain`, Android `SecureStore` — grew
//! the same three operations in the same change.
//!
//! A document-portal vault's path contains a document id. Re-picking the same
//! folder returns the SAME id while its entry exists (`REUSE_EXISTING`), so an
//! ordinary re-pick keeps the saved password; a folder re-picked after its entry
//! was REVOKED comes back under a new id, orphaning the account, and sync asks
//! once more. Deliberate: the new path cannot prove "same vault", a wrong guess
//! would hand one vault's password to another, and the cost is one re-prompt
//! after an explicit revocation — with the M3 dev/prod split intact.

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

/// Bytes in a vault key — the symmetric key the sync engine encrypts notes
/// with, not anything derived from it at read time.
const VAULT_KEY_BYTES: usize = 32;

fn vault_key_account_for(root: &Path) -> String {
    format!("vault-key:{}", root.to_string_lossy())
}

fn session_token_account_for(root: &Path) -> String {
    format!("session-token:{}", root.to_string_lossy())
}

// The keyring stores strings, so the key travels as lowercase hex. A stored
// entry that is not 32 bytes of hex is an error rather than a silently short
// key: a caller that encrypted notes with it would produce unreadable objects.
#[allow(dead_code)] // Caller lands with the hosted sync flow; see the module header.
fn vault_key_get_impl(
    store: &dyn SecretStore,
    root: &Path,
) -> Result<Option<[u8; VAULT_KEY_BYTES]>, String> {
    let Some(encoded) = store.get(&vault_key_account_for(root))? else {
        return Ok(None);
    };
    let bytes = hex::decode(&encoded).map_err(|e| format!("stored vault key is not hex: {e}"))?;
    let key: [u8; VAULT_KEY_BYTES] = bytes.try_into().map_err(|bytes: Vec<u8>| {
        format!(
            "stored vault key is {} bytes, expected {VAULT_KEY_BYTES}",
            bytes.len()
        )
    })?;
    Ok(Some(key))
}

#[allow(dead_code)] // Caller lands with the hosted sync flow; see the module header.
fn vault_key_set_impl(
    store: &dyn SecretStore,
    root: &Path,
    key: &[u8; VAULT_KEY_BYTES],
) -> Result<(), String> {
    store.set(&vault_key_account_for(root), &hex::encode(key))
}

#[allow(dead_code)] // Caller lands with the hosted sync flow; see the module header.
fn vault_key_delete_impl(store: &dyn SecretStore, root: &Path) -> Result<(), String> {
    store.delete(&vault_key_account_for(root))
}

#[allow(dead_code)] // Caller lands with the hosted sync flow; see the module header.
fn session_token_get_impl(store: &dyn SecretStore, root: &Path) -> Result<Option<String>, String> {
    store.get(&session_token_account_for(root))
}

#[allow(dead_code)] // Caller lands with the hosted sync flow; see the module header.
fn session_token_set_impl(store: &dyn SecretStore, root: &Path, token: &str) -> Result<(), String> {
    store.set(&session_token_account_for(root), token)
}

#[allow(dead_code)] // Caller lands with the hosted sync flow; see the module header.
fn session_token_delete_impl(store: &dyn SecretStore, root: &Path) -> Result<(), String> {
    store.delete(&session_token_account_for(root))
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

    // ── Vault key and session token ──────────────────────────────────────

    const A_KEY: [u8; VAULT_KEY_BYTES] = [7u8; VAULT_KEY_BYTES];

    #[test]
    fn vault_key_roundtrips_and_deletes_idempotently() {
        let store = MemStore::default();
        let root = Path::new("/vault");
        assert_eq!(vault_key_get_impl(&store, root).unwrap(), None);
        vault_key_set_impl(&store, root, &A_KEY).unwrap();
        assert_eq!(vault_key_get_impl(&store, root).unwrap(), Some(A_KEY));
        vault_key_delete_impl(&store, root).unwrap();
        assert_eq!(vault_key_get_impl(&store, root).unwrap(), None);
        vault_key_delete_impl(&store, root).unwrap();
    }

    #[test]
    fn session_token_roundtrips_and_deletes_idempotently() {
        let store = MemStore::default();
        let root = Path::new("/vault");
        assert_eq!(session_token_get_impl(&store, root).unwrap(), None);
        session_token_set_impl(&store, root, "session-abc").unwrap();
        assert_eq!(
            session_token_get_impl(&store, root).unwrap(),
            Some("session-abc".to_owned())
        );
        session_token_delete_impl(&store, root).unwrap();
        assert_eq!(session_token_get_impl(&store, root).unwrap(), None);
        session_token_delete_impl(&store, root).unwrap();
    }

    #[test]
    fn the_three_secrets_are_independent_entries_for_one_vault() {
        // The point of the prefactor: adding a key and a token must not disturb
        // the password entry, and deleting one must not take the others with it.
        let store = MemStore::default();
        let root = Path::new("/vault");
        set_impl(&store, root, "hunter2").unwrap();
        vault_key_set_impl(&store, root, &A_KEY).unwrap();
        session_token_set_impl(&store, root, "session-abc").unwrap();

        vault_key_delete_impl(&store, root).unwrap();
        assert_eq!(get_impl(&store, root).unwrap(), Some("hunter2".to_owned()));
        assert_eq!(
            session_token_get_impl(&store, root).unwrap(),
            Some("session-abc".to_owned())
        );
    }

    #[test]
    fn the_password_account_is_still_the_bare_notes_root_path() {
        // Pins the compatibility promise in the module header: entries written
        // before the key and the token existed must keep resolving.
        assert_eq!(
            account_for(Path::new("/home/u/Documents/fake-notes")),
            "/home/u/Documents/fake-notes"
        );
    }

    #[test]
    fn distinct_vault_roots_do_not_share_a_key_or_a_token() {
        // The M3 dev/prod split again, for the two new secrets.
        let store = MemStore::default();
        let dev = Path::new("/home/u/Documents/fake-notes");
        let prod = Path::new("/home/u/Documents/futo-notes");
        vault_key_set_impl(&store, dev, &A_KEY).unwrap();
        session_token_set_impl(&store, dev, "dev-session").unwrap();
        assert_eq!(vault_key_get_impl(&store, prod).unwrap(), None);
        assert_eq!(session_token_get_impl(&store, prod).unwrap(), None);
    }

    #[test]
    fn a_stored_vault_key_of_the_wrong_length_is_an_error_not_a_short_key() {
        let store = MemStore::default();
        let root = Path::new("/vault");
        store
            .set(&vault_key_account_for(root), &hex::encode([1u8; 16]))
            .unwrap();
        let error = vault_key_get_impl(&store, root).unwrap_err();
        assert!(error.contains("16 bytes"), "unexpected error: {error}");
    }

    #[test]
    fn a_stored_vault_key_that_is_not_hex_is_an_error() {
        let store = MemStore::default();
        let root = Path::new("/vault");
        store
            .set(&vault_key_account_for(root), "not hex at all")
            .unwrap();
        let error = vault_key_get_impl(&store, root).unwrap_err();
        assert!(error.contains("not hex"), "unexpected error: {error}");
    }

    #[test]
    fn a_re_granted_portal_vault_asks_for_the_password_again() {
        // Pins the documented trade-off in this module's header rather than
        // leaving it as prose: the account is the path, and a folder re-picked
        // after its grant was revoked comes back under a new document id, so
        // that recovery re-prompts. If this ever starts returning the old
        // secret, the account scheme changed and the header needs rewriting.
        let store = MemStore::default();
        set_impl(&store, Path::new("/run/user/1000/doc/A1b2C3/Notes"), "pw").unwrap();
        assert_eq!(
            get_impl(&store, Path::new("/run/user/1000/doc/Z9y8X7/Notes")).unwrap(),
            None
        );
    }
}

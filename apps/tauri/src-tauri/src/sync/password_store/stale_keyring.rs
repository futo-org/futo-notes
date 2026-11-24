//! The bridge between the debug-only QA memory store and the keyring: a QA
//! process that changes a vault's secrets marks the keyring's entries stale,
//! and the keyring deletes them before its next access to that vault.

use std::path::Path;

use super::{delete_impl, session_token_delete_impl, vault_key_delete_impl, Access, SecretStore};

/// Left in a vault root by a QA process (the debug-only memory store) that
/// changed that vault's secrets. Its connect, sign-out or forget also changed
/// the vault's files — another server's URL, a cleared deletion marker — while
/// the keyring kept the old entries, so they no longer belong to this vault.
/// The next keyring-backed process deletes them before it reads any. Holds no
/// secret: only its presence matters.
const STALE_KEYRING_MARKER: &str = ".qa-stale-keyring";

/// A QA store marks the keyring stale before its first change to a vault's
/// secrets; the keyring discards a vault's entries while that mark is there.
pub(super) fn resolve_store<'s>(
    qa: Option<&'s dyn SecretStore>,
    keyring: &'s dyn SecretStore,
    root: &Path,
    access: Access,
) -> Result<&'s dyn SecretStore, String> {
    let marker = root.join(STALE_KEYRING_MARKER);
    if let Some(qa) = qa {
        if access == Access::Write {
            std::fs::write(&marker, b"")
                .map_err(|e| format!("could not mark the keyring stale: {e}"))?;
        }
        return Ok(qa);
    }
    if marker.exists() {
        delete_impl(keyring, root)?;
        vault_key_delete_impl(keyring, root)?;
        session_token_delete_impl(keyring, root)?;
        match std::fs::remove_file(&marker) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("could not clear the stale-keyring mark: {e}")),
        }
    }
    Ok(keyring)
}

#[cfg(test)]
mod tests {
    use super::super::qa_store::MemoryStore as MemStore;
    use super::super::*;
    use super::*;

    const A_KEY: [u8; VAULT_KEY_BYTES] = [7u8; VAULT_KEY_BYTES];

    /// A fresh, empty vault root under the system temp dir.
    fn temp_vault(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "futo-notes-password-store-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// The keyring as an ordinary launch finds it: this vault saved against server A.
    fn keyring_saved_for_server_a(root: &Path) -> MemStore {
        let keyring = MemStore::default();
        set_impl(&keyring, root, "server-a-password").unwrap();
        session_token_set_impl(&keyring, root, "server-a-token").unwrap();
        vault_key_set_impl(&keyring, root, &A_KEY).unwrap();
        keyring
    }

    #[test]
    fn a_qa_connect_leaves_no_old_server_credential_for_the_next_ordinary_launch() {
        // A QA process connects the vault to server B: the vault's files now name
        // B, while the keyring still holds A's password and token. The next
        // ordinary launch must not hand A's credentials to B.
        let root = temp_vault("qa-connect");
        let keyring = keyring_saved_for_server_a(&root);
        let qa = MemStore::default();

        let store = resolve_store(Some(&qa), &keyring, &root, Access::Write).unwrap();
        set_impl(store, &root, "server-b-password").unwrap();
        session_token_set_impl(store, &root, "server-b-token").unwrap();

        let store = resolve_store(None, &keyring, &root, Access::Read).unwrap();
        assert_eq!(session_token_get_impl(store, &root).unwrap(), None);
        assert_eq!(get_impl(store, &root).unwrap(), None);
        assert_eq!(vault_key_get_impl(store, &root).unwrap(), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_qa_forget_stays_forgotten_on_the_next_ordinary_launch() {
        // A QA boot retries a pending keyring deletion against its empty memory
        // store and then clears the vault's deletion marker; the credential the
        // user asked to forget must not come back on the next ordinary launch.
        let root = temp_vault("qa-forget");
        let keyring = keyring_saved_for_server_a(&root);
        let qa = MemStore::default();

        let store = resolve_store(Some(&qa), &keyring, &root, Access::Write).unwrap();
        delete_impl(store, &root).unwrap();
        session_token_delete_impl(store, &root).unwrap();

        let store = resolve_store(None, &keyring, &root, Access::Read).unwrap();
        assert_eq!(get_impl(store, &root).unwrap(), None);
        assert_eq!(session_token_get_impl(store, &root).unwrap(), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_qa_launch_that_changes_nothing_keeps_the_keyring_entries() {
        // Reading from the memory store is no reason to forget what an ordinary
        // launch saved, and once a stale keyring is cleared it stays usable.
        let root = temp_vault("qa-read");
        let keyring = keyring_saved_for_server_a(&root);
        let qa = MemStore::default();

        let store = resolve_store(Some(&qa), &keyring, &root, Access::Read).unwrap();
        assert_eq!(get_impl(store, &root).unwrap(), None);

        let store = resolve_store(None, &keyring, &root, Access::Read).unwrap();
        assert_eq!(
            get_impl(store, &root).unwrap(),
            Some("server-a-password".to_owned())
        );
        assert!(!root.join(STALE_KEYRING_MARKER).exists());
        std::fs::remove_dir_all(&root).unwrap();
    }
}

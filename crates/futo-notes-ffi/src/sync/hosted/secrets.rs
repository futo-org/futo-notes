//! The device's secret store, implemented by each shell, and its engine adapter.

use super::*;

/// Where this device keeps the vault key and the session token: the iOS
/// Keychain, Android's `SecureStore`. The engine names the two secrets; the
/// shell that implements this says where they live, scoped to one notes root.
///
/// A missing entry is `null`, never an error — a device that has not been set
/// up is the ordinary case — and deleting something absent succeeds. These
/// run on Tokio workers and may block; they never touch UI.
///
/// `delete_sync_password` is the odd one out: the secret it removes belongs to
/// self-hosted sync, which is app-global on both shells rather than scoped to
/// this notes root. The engine calls it at the one moment a hosted session
/// starts, so a device is never holding both credentials — see
/// `futo_notes_sync::VaultSecrets::delete_sync_password` for why.
#[uniffi::export(callback_interface)]
pub trait VaultSecretStore: Send + Sync {
    fn vault_key(&self) -> Result<Option<Vec<u8>>, SecretStoreError>;
    fn set_vault_key(&self, key: Vec<u8>) -> Result<(), SecretStoreError>;
    fn delete_vault_key(&self) -> Result<(), SecretStoreError>;
    fn session_token(&self) -> Result<Option<String>, SecretStoreError>;
    fn set_session_token(&self, token: String) -> Result<(), SecretStoreError>;
    fn delete_session_token(&self) -> Result<(), SecretStoreError>;
    fn delete_sync_password(&self) -> Result<(), SecretStoreError>;
}

/// Adapts a shell's store to the engine's port. The one thing it adds is a
/// length check: a stored key that is not 32 bytes would encrypt notes nothing
/// could read back, so it is an error rather than a silently padded key.
pub(super) struct ShellSecrets(pub(super) Arc<dyn VaultSecretStore>);

impl VaultSecrets for ShellSecrets {
    fn vault_key(&self) -> Result<Option<[u8; 32]>, String> {
        let Some(bytes) = self.0.vault_key().map_err(|error| error.to_string())? else {
            return Ok(None);
        };
        let key: [u8; 32] = bytes.try_into().map_err(|bytes: Vec<u8>| {
            format!("stored vault key is {} bytes, expected 32", bytes.len())
        })?;
        Ok(Some(key))
    }

    fn set_vault_key(&self, key: &[u8; 32]) -> Result<(), String> {
        self.0
            .set_vault_key(key.to_vec())
            .map_err(|error| error.to_string())
    }

    fn delete_vault_key(&self) -> Result<(), String> {
        self.0.delete_vault_key().map_err(|error| error.to_string())
    }

    fn session_token(&self) -> Result<Option<String>, String> {
        self.0.session_token().map_err(|error| error.to_string())
    }

    fn set_session_token(&self, token: &str) -> Result<(), String> {
        self.0
            .set_session_token(token.to_owned())
            .map_err(|error| error.to_string())
    }

    fn delete_session_token(&self) -> Result<(), String> {
        self.0
            .delete_session_token()
            .map_err(|error| error.to_string())
    }

    fn delete_sync_password(&self) -> Result<(), String> {
        self.0
            .delete_sync_password()
            .map_err(|error| error.to_string())
    }
}

pub(super) fn engine_secrets(store: Box<dyn VaultSecretStore>) -> Arc<dyn VaultSecrets> {
    Arc::new(ShellSecrets(Arc::from(store)))
}

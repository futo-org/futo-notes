//! What this device keeps after a hosted setup finishes, and where.
//!
//! Two secrets survive the wizard: the 32-byte vault key and the session token
//! (ADR 0003, decision 4). The vault password is not one of them — it is typed
//! once, unwraps the key, and is forgotten, which is what lets a device set up
//! by recovery key or by a paired device be indistinguishable afterwards.
//!
//! The engine names the two secrets; the shell says where they live. Secret
//! Service / Keychain / Credential Manager on desktop, the iOS Keychain, and
//! Android's `SecureStore` are three different APIs, and each is already scoped
//! per notes root by the shell that owns it — so this trait takes no root.

use futo_notes_core::e2ee::KEY_BYTES;

/// One vault's hosted secrets in the OS secret store.
///
/// Implementations are scoped to a single notes root, so two vaults on one
/// machine never read each other's key. Every method is synchronous and may
/// block (a keyring call can reach D-Bus); the engine calls them off the async
/// runtime.
///
/// A missing entry is `Ok(None)`, never an error: a device that has not been
/// set up is the ordinary case. Deleting something that is not there succeeds.
pub trait VaultSecrets: Send + Sync + 'static {
    fn vault_key(&self) -> Result<Option<[u8; KEY_BYTES]>, String>;
    fn set_vault_key(&self, key: &[u8; KEY_BYTES]) -> Result<(), String>;
    fn delete_vault_key(&self) -> Result<(), String>;

    fn session_token(&self) -> Result<Option<String>, String>;
    fn set_session_token(&self, token: &str) -> Result<(), String>;
    fn delete_session_token(&self) -> Result<(), String>;
}

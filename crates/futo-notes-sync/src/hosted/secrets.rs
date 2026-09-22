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
//!
//! One secret the engine names but never writes: the self-hosted sync
//! password. It belongs to the other way of syncing, and the two are exclusive
//! — see [`VaultSecrets::delete_sync_password`].

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

    /// Forget the self-hosted sync password, if this device is keeping one.
    ///
    /// The one secret here that hosted sync does not own. A device syncs
    /// against the FUTO service or against someone's own server, never both,
    /// and the stored password is what reconnects to the latter — on every
    /// shell it is app-global rather than per-vault, so its mere presence
    /// cannot say which kind of vault this is. Every shell resolves that
    /// ambiguity the same way, by trying the password first, which on a device
    /// that had moved to hosted sync meant reconnecting to the abandoned
    /// self-hosted server at every launch and never resuming the hosted
    /// session at all (device QA, 2026-09-16; Justin's call the same day).
    ///
    /// So exactly one sync credential exists at a time, and whichever mode was
    /// set up last wins: [`crate::HostedSetup::connect_sync`] clears the
    /// password, while setting up self-hosted sync leaves the hosted secrets
    /// to the sign-out that owns them and the password branch takes it from
    /// there. "Is there a password?" is then a correct answer to "which mode
    /// is this device in?" rather than a guess.
    ///
    /// Idempotent, like the other deletes: a device that never had one
    /// succeeds.
    fn delete_sync_password(&self) -> Result<(), String>;
}

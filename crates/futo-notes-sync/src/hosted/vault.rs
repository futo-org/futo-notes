//! The three vault doors and the step the wizard is on.
//!
//! After sign-in a person either creates a vault — choosing a vault password
//! and saving the recovery key it hands back once — or unlocks one that
//! already exists, by vault password or by recovery key. Either way the device
//! ends up holding the 32-byte vault key and the session token, and never asks
//! again (ADR 0003, decisions 3, 4, 6 and 7).
//!
//! **Which step to show is computed, never remembered.** [`HostedSetup::current_step`]
//! reads four facts — is there a session, may the account write, does the vault
//! have key material, does this device hold the key — and answers from those
//! alone. Nothing about where the person got to is written down, so quitting
//! halfway and reopening lands on the right screen by construction rather than
//! by a saved cursor that can disagree with the server.

use std::path::Path;
use std::sync::Arc;

use futo_notes_core::e2ee::{self, E2eeError, KeyMaterial, RecoveryKey, KEY_BYTES};

mod key_material;
mod rewrap;
mod session;

use super::secrets::VaultSecrets;
use super::{HostedError, HostedSession, HostedSetup};
use crate::server::{hosted_error, KeyRewrap};
use crate::session::SyncSession;
use key_material::{blocking, blocking_secrets, crypto};

/// The shortest vault password this will create a vault with (ADR 0003,
/// decision 7). There are no composition rules; length is the whole bar, and
/// it lives here so three shells cannot each pick their own.
pub const MIN_VAULT_PASSWORD_CHARS: usize = 12;

/// Which screen the wizard is on, derived from server facts and this device's
/// secret store. There is no `Done` that differs from `Ready`, and no variant
/// for "showing the recovery key": that screen exists only in the moment
/// [`HostedSetup::create_vault`] returns, because the key is handed over once
/// and the engine keeps no copy to hand over again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupStep {
    /// No session: "Log in with FUTO".
    SignIn,
    /// Signed in, no vault yet, and the account may not write. Creating a
    /// vault is an entitlement-gated write, which is why this step cannot be
    /// skipped in the no-vault shape.
    Subscribe,
    /// Signed in and entitled, with no vault yet: choose a vault password.
    CreateVault,
    /// The vault exists but this device does not hold its key: unlock by vault
    /// password or by recovery key.
    Unlock,
    /// Signed in, unlocked, and holding the key. Nothing left to ask.
    Ready,
}

impl HostedSetup {
    /// Attaches this device's secret store. Without one the setup can still
    /// probe, sign in, and read billing, but every step that keeps or reads a
    /// secret refuses — there would be nowhere to put the vault key.
    pub fn with_secrets(mut self, secrets: Arc<dyn VaultSecrets>) -> Self {
        self.secrets = Some(secrets);
        self
    }

    /// Which screen to show. Four reads and no memory: a session (from this
    /// attempt or from the token this device saved), whether the vault has key
    /// material, whether this device holds the vault key, and — only when
    /// there is no vault — whether the account may write.
    pub async fn current_step(&self) -> Result<SetupStep, HostedError> {
        // This device's own fact first: a setup with nowhere to keep a vault
        // key says so before spending a round trip finding out.
        let holds_the_key = self.stored_vault_key().await?.is_some();
        if self.restored_session().await?.is_none() {
            return Ok(SetupStep::SignIn);
        }
        let collection = self.collection().await?;
        if self.key_material(&collection).await?.is_some() {
            return Ok(if holds_the_key {
                SetupStep::Ready
            } else {
                SetupStep::Unlock
            });
        }
        Ok(if self.billing_status().await?.entitled {
            SetupStep::CreateVault
        } else {
            SetupStep::Subscribe
        })
    }

    /// Creates this account's vault: a fresh 32-byte key wrapped twice, under
    /// the vault password with Argon2id and under a generated recovery key,
    /// written to the server as one key material.
    ///
    /// **The returned recovery key is the only copy that ever leaves here.**
    /// The setup keeps none, there is no second accessor, and a second call
    /// fails with [`HostedError::VaultAlreadyExists`] — which is what makes it
    /// structurally impossible to show twice.
    pub async fn create_vault(&self, vault_password: &str) -> Result<String, HostedError> {
        if vault_password.chars().count() < MIN_VAULT_PASSWORD_CHARS {
            return Err(HostedError::VaultPasswordTooShort {
                minimum: MIN_VAULT_PASSWORD_CHARS as u32,
            });
        }
        let collection = self.collection().await?;
        if self.key_material(&collection).await?.is_some() {
            return Err(HostedError::VaultAlreadyExists);
        }

        let password = vault_password.to_owned();
        let (vault_key, recovery_key, material) = blocking(move || {
            let vault_key = e2ee::generate_vault_key();
            let mut material = e2ee::wrap_vault_key_argon2id(&vault_key, &password)?;
            let recovery_key = RecoveryKey::generate();
            material.set_recovery_envelope(&vault_key, &recovery_key)?;
            Ok::<_, E2eeError>((vault_key, recovery_key.to_string(), material))
        })
        .await?
        .map_err(crypto)?;

        // A claim that carries no revision token never overwrites: the server
        // answers with the authoritative material, which is someone else's if
        // two devices claimed at once. Ours or not decides whether this vault
        // key is the vault's key at all.
        let stored = self.put_key_material(&collection, &material).await?;
        if stored.encrypted_vault_key != material.encrypted_vault_key {
            return Err(HostedError::VaultAlreadyExists);
        }

        self.keep(vault_key).await?;
        Ok(recovery_key)
    }

    /// Unlocks an existing vault with its vault password, and keeps the key.
    pub async fn unlock_with_vault_password(
        &self,
        vault_password: &str,
    ) -> Result<(), HostedError> {
        let material = self.vault_material().await?;
        let password = vault_password.to_owned();
        let vault_key = blocking(move || e2ee::unwrap_vault_key(&password, &material))
            .await?
            .map_err(|error| match error {
                E2eeError::BadPassword => HostedError::WrongVaultPassword,
                other => crypto(other),
            })?;
        self.keep(vault_key).await
    }

    /// Unlocks an existing vault with its recovery key, and keeps the key.
    ///
    /// What the person typed is parsed first, so a mistyped character is
    /// reported as the typo it is — before the vault's key material is
    /// fetched, and with nothing sent anywhere (parent spec user story 18).
    pub async fn unlock_with_recovery_key(&self, typed: &str) -> Result<(), HostedError> {
        let recovery_key = RecoveryKey::parse(typed).map_err(|error| match error {
            E2eeError::RecoveryKeyCheck => HostedError::RecoveryKeyTypo,
            _ => HostedError::RecoveryKeyFormat,
        })?;
        let material = self.vault_material().await?;
        let vault_key =
            blocking(move || e2ee::unwrap_vault_key_with_recovery_key(&recovery_key, &material))
                .await?
                .map_err(|error| match error {
                    E2eeError::BadRecoveryKey => HostedError::WrongRecoveryKey,
                    E2eeError::NoRecoveryEnvelope => HostedError::NoRecoveryKey,
                    other => crypto(other),
                })?;
        self.keep(vault_key).await
    }
}

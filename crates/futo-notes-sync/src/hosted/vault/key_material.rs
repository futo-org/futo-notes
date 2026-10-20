//! This account's collection and key material, and the blocking-work wrappers around them.

use super::*;

impl HostedSetup {
    /// The vault's key material, refusing when there is no vault to unlock.
    pub(super) async fn vault_material(&self) -> Result<KeyMaterial, HostedError> {
        let collection = self.collection().await?;
        self.key_material(&collection)
            .await?
            .ok_or(HostedError::NoVault)
    }

    /// This account's one collection, claimed if it has none. Claiming is
    /// idempotent on the server and is not entitlement-gated, so an account
    /// that has not paid yet can still reach this far.
    pub(super) async fn collection(&self) -> Result<String, HostedError> {
        if let Some(id) = self.collection_id() {
            return Ok(id);
        }
        let id = self
            .authorized()
            .await?
            .create_collection()
            .await
            .map_err(hosted_error)?;
        *self.collection_id.lock().expect("hosted collection lock") = Some(id.clone());
        Ok(id)
    }

    /// `None` here is exactly "no vault yet" to the wizard.
    ///
    /// What comes back is remembered, revision token and all, because it is
    /// the material the person is then looking at: a re-wrap they ask for
    /// afterwards is guarded by *this* read (see [`HostedSetup::rewrap`]).
    pub(super) async fn key_material(
        &self,
        collection: &str,
    ) -> Result<Option<KeyMaterial>, HostedError> {
        let material = self
            .authorized()
            .await?
            .key(collection)
            .await
            .map_err(hosted_error)?;
        self.remember_material(material.clone());
        Ok(material)
    }

    /// The vault's key material as this device last saw it, reading it when
    /// this attempt has not yet.
    pub(super) async fn known_material(&self) -> Result<KeyMaterial, HostedError> {
        if let Some(material) = self
            .key_material
            .lock()
            .expect("hosted key material lock")
            .clone()
        {
            return Ok(material);
        }
        self.vault_material().await
    }

    pub(super) fn remember_material(&self, material: Option<KeyMaterial>) {
        *self.key_material.lock().expect("hosted key material lock") = material;
    }

    /// Writes both envelopes in one request, which is the only shape the
    /// server offers: omitting the recovery fields would delete the recovery
    /// envelope rather than leave it alone (server ADR 0006, rule 2).
    ///
    /// The answer is the **authoritative** material, which is not always what
    /// was sent — a claim that loses a race gets the winner's back.
    pub(super) async fn put_key_material(
        &self,
        collection: &str,
        material: &KeyMaterial,
    ) -> Result<KeyMaterial, HostedError> {
        let stored = self
            .authorized()
            .await?
            .put_key(collection, material)
            .await
            .map_err(hosted_error)?;
        self.remember_material(Some(stored.clone()));
        Ok(stored)
    }

    /// Writes both secrets, so the next cold start needs no prompt at all.
    pub(in crate::hosted) async fn keep(
        &self,
        vault_key: [u8; KEY_BYTES],
    ) -> Result<(), HostedError> {
        let token = self
            .restored_session()
            .await?
            .map(|session| session.token)
            .ok_or(HostedError::NotSignedIn)?;
        let secrets = self.secrets()?;
        blocking_secrets(secrets, move |store| {
            store.set_vault_key(&vault_key)?;
            store.set_session_token(&token)
        })
        .await
    }

    pub(in crate::hosted) async fn stored_vault_key(
        &self,
    ) -> Result<Option<[u8; KEY_BYTES]>, HostedError> {
        let secrets = self.secrets()?;
        blocking_secrets(secrets, |store| store.vault_key()).await
    }

    /// Best-effort: a setup with no secret store attached signs in fine, it
    /// just does not remember. Only the steps that must keep a secret refuse.
    pub(in crate::hosted) async fn remember_token(&self, token: &str) {
        if let Some(secrets) = self.secrets.clone() {
            let token = token.to_owned();
            let _ = blocking_secrets(secrets, move |store| store.set_session_token(&token)).await;
        }
    }

    pub(super) fn secrets(&self) -> Result<Arc<dyn VaultSecrets>, HostedError> {
        self.secrets.clone().ok_or_else(|| {
            HostedError::SecretStore("this device has no secret store attached".into())
        })
    }
}

/// Anything that went wrong in the crypto itself and is not a secret a person
/// can retype: an unreadable envelope, an unsupported KDF, a panicked task.
pub(super) fn crypto(error: E2eeError) -> HostedError {
    HostedError::Crypto(error.to_string())
}

/// Runs crypto off the async runtime. Argon2id at 64 MiB is tens of
/// milliseconds of solid CPU; on the runtime it would stall every other task.
/// The work's own failure stays inside `T`, so each caller names the one
/// `E2eeError` that is a person's mistake rather than the engine's.
pub(super) async fn blocking<T, F>(work: F) -> Result<T, HostedError>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| HostedError::Crypto(error.to_string()))
}

/// Same, for the secret store: a keyring read can reach D-Bus and block.
pub(super) async fn blocking_secrets<T, F>(
    secrets: Arc<dyn VaultSecrets>,
    work: F,
) -> Result<T, HostedError>
where
    T: Send + 'static,
    F: FnOnce(&dyn VaultSecrets) -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(move || work(secrets.as_ref()))
        .await
        .map_err(|error| HostedError::SecretStore(error.to_string()))?
        .map_err(HostedError::SecretStore)
}

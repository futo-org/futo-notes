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

use super::secrets::VaultSecrets;
use super::{HostedError, HostedSession, HostedSetup};
use crate::server::{hosted_error, KeyRewrap};
use crate::session::SyncSession;

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

    /// Sets a new vault password on a vault this device is already holding
    /// the key to (ADR 0003, decision 10; parent spec user story 31).
    ///
    /// **It asks for no current secret.** The device has the vault key, so
    /// there is nothing to prove — and a device set up by scanning a QR code
    /// never knew the old password to be asked for it. The vault key itself is
    /// unchanged, which is the whole reason every other device carries on
    /// untouched: their copy of that key still opens every note, and they are
    /// never told anything happened (parent spec user story 33).
    ///
    /// Only the password envelope is rebuilt. The recovery envelope goes back
    /// unchanged in the same write, because a `PUT` replaces the whole of the
    /// key material and leaving it out would delete a working recovery door
    /// (server ADR 0006, rule 2).
    pub async fn change_vault_password(&self, new_password: &str) -> Result<(), HostedError> {
        if new_password.chars().count() < MIN_VAULT_PASSWORD_CHARS {
            return Err(HostedError::VaultPasswordTooShort {
                minimum: MIN_VAULT_PASSWORD_CHARS as u32,
            });
        }
        let password = new_password.to_owned();
        self.rewrap(move |vault_key, known| {
            let mut material = e2ee::wrap_vault_key_argon2id(vault_key, &password)?;
            material.recovery_key_salt = known.recovery_key_salt.clone();
            material.recovery_key_kdf = known.recovery_key_kdf.clone();
            material.recovery_encrypted_vault_key = known.recovery_encrypted_vault_key.clone();
            Ok((material, None))
        })
        .await
        .map(|_| ())
    }

    /// Issues a new recovery key and answers with it, once (ADR 0003, decision
    /// 10; parent spec user story 32).
    ///
    /// **The old key stops working the moment this lands**: the recovery
    /// envelope it opened is replaced by one wrapped under the new key, and
    /// there is only ever one. Like [`HostedSetup::create_vault`], nothing
    /// here keeps a copy of what it returns.
    ///
    /// Only the recovery envelope is rebuilt; the password envelope goes back
    /// unchanged, so the vault password a person already knows still works.
    pub async fn new_recovery_key(&self) -> Result<String, HostedError> {
        let recovery_key = self
            .rewrap(|vault_key, known| {
                let mut material = known.clone();
                let recovery_key = RecoveryKey::generate();
                material.set_recovery_envelope(vault_key, &recovery_key)?;
                Ok((material, Some(recovery_key.to_string())))
            })
            .await?;
        Ok(recovery_key.expect("a new recovery key is always produced"))
    }

    /// The shape both of the above share: re-wrap one envelope of the material
    /// this device last read, carry the other back untouched, and write both
    /// guarded by the revision that read came with.
    ///
    /// A stale guard is [`HostedError::VaultKeyChangedElsewhere`] and nothing
    /// else — no retry loop here, because retrying would overwrite whatever
    /// the other device did without anyone being told. What is adopted instead
    /// is the authoritative material the server sent with its refusal, so the
    /// person's own second press re-wraps from that and lands.
    async fn rewrap<F>(&self, build: F) -> Result<Option<String>, HostedError>
    where
        F: FnOnce(
                &[u8; KEY_BYTES],
                &KeyMaterial,
            ) -> Result<(KeyMaterial, Option<String>), E2eeError>
            + Send
            + 'static,
    {
        let vault_key = self
            .stored_vault_key()
            .await?
            .ok_or(HostedError::VaultLocked)?;
        let known = self.known_material().await?;
        let previous = known.key_updated_at.clone().ok_or_else(|| {
            HostedError::Server(
                "the server did not say when this vault's key material was last written".into(),
            )
        })?;

        let (mut material, produced) = blocking(move || build(&vault_key, &known))
            .await?
            .map_err(crypto)?;
        // The revision token travels as `previous_key_updated_at`; carrying a
        // second copy inside the material would say the same thing twice, in a
        // field the server writes rather than reads.
        material.key_updated_at = None;

        let collection = self.collection().await?;
        let written = self
            .authorized()
            .await?
            .rewrap_key(&collection, &material, &previous)
            .await
            .map_err(hosted_error)?;
        match written {
            KeyRewrap::Written(stored) => {
                self.remember_material(Some(stored));
                Ok(produced)
            }
            KeyRewrap::Stale(current) => {
                self.remember_material(Some(current));
                Err(HostedError::VaultKeyChangedElsewhere)
            }
        }
    }

    /// Hands this device's hosted secrets to the sync engine, so cycles can
    /// run. The step after [`SetupStep::Ready`], and the mirror image of
    /// [`HostedSetup::sign_out`].
    ///
    /// Every door out of the wizard ends here — a vault password, a recovery
    /// key, or a paired device — because all three end with the same two
    /// secrets in the same place. It is safe to call again: connecting an
    /// already-connected session rebuilds it from the same facts, which is what
    /// makes it callable whenever a shell notices the vault is unlocked rather
    /// than only at the one moment it became so.
    ///
    /// Refuses rather than half-connecting: a device with no vault key is
    /// [`HostedError::VaultLocked`], and one with no session is
    /// [`HostedError::NotSignedIn`].
    pub async fn connect_sync(&self, sync: &SyncSession, root: &Path) -> Result<(), HostedError> {
        let session = self
            .restored_session()
            .await?
            .ok_or(HostedError::NotSignedIn)?;
        let vault_key = self
            .stored_vault_key()
            .await?
            .ok_or(HostedError::VaultLocked)?;
        let collection_id = self.collection().await?;
        sync.connect_hosted(
            root,
            crate::HostedCredentials {
                server_url: self.server_url().to_owned(),
                token: session.token,
                user_id: session.user_id,
                collection_id,
                vault_key,
            },
        )
        .await
        .map_err(|error| HostedError::Server(error.to_string()))
    }

    /// Whether this device has a hosted vault it can resume: **both** secrets
    /// in the secret store, read locally with no request of any kind.
    ///
    /// This is the cold-start question, and it is deliberately not
    /// [`HostedSetup::current_step`] or [`HostedSetup::connect_sync`] — both of
    /// those validate the saved token with `current_user` and resolve the
    /// collection, so on a fresh process both reach the network before they can
    /// answer anything. A shell restoring a session at launch has to know
    /// whether this vault is hosted *before* it is willing to spend a round
    /// trip, and offline it has to know without one at all.
    ///
    /// Both or neither: a token with no vault key cannot decrypt, and a vault
    /// key with no token cannot authenticate, so either one alone is not a
    /// session to resume. A setup with no secret store attached refuses rather
    /// than answering `false`, which a shell would read as "not hosted".
    pub async fn has_saved_vault(&self) -> Result<bool, HostedError> {
        let secrets = self.secrets()?;
        blocking_secrets(secrets, |store| {
            Ok(store.vault_key()?.is_some() && store.session_token()?.is_some())
        })
        .await
    }

    /// Signs out: revoke the session on the server, forget both secrets, and
    /// demote this vault's sync state exactly as disconnect does — one action,
    /// with no locked-but-signed-in halfway state left behind (ADR 0003,
    /// decision 9). The notes on disk are untouched.
    ///
    /// The server call is best-effort. A person who taps Sign out on a plane
    /// is signed out of this device either way; the session ages out on its
    /// own.
    pub async fn sign_out(&self, sync: &SyncSession, root: &Path) -> Result<(), HostedError> {
        if let Ok(http) = self.authorized().await {
            let _ = http.logout().await;
        }
        *self.session.lock().expect("hosted session lock") = None;
        *self.collection_id.lock().expect("hosted collection lock") = None;

        let secrets = self.secrets()?;
        let forgotten = blocking_secrets(secrets, |store| {
            let key = store.delete_vault_key();
            let token = store.delete_session_token();
            key.and(token)
        })
        .await;

        sync.disconnect(root)
            .await
            .map_err(|error| HostedError::Server(error.to_string()))?;
        forgotten
    }

    /// This attempt's collection, once one has been resolved.
    pub fn collection_id(&self) -> Option<String> {
        self.collection_id
            .lock()
            .expect("hosted collection lock")
            .clone()
    }

    /// The session this setup is acting as, adopting the token this device
    /// saved if the attempt has none of its own. A saved token the server no
    /// longer accepts is deleted rather than retried on every start; the vault
    /// key is left exactly where it is, because an expired session is a trip
    /// to the browser and never a vault reset.
    pub(super) async fn restored_session(&self) -> Result<Option<HostedSession>, HostedError> {
        if let Some(session) = self.session() {
            return Ok(Some(session));
        }
        // A setup with no secret store has nothing saved to adopt; only the
        // steps that must keep a secret refuse outright.
        let Some(secrets) = self.secrets.clone() else {
            return Ok(None);
        };
        let Some(token) = blocking_secrets(secrets, |store| store.session_token()).await? else {
            return Ok(None);
        };
        match self.http.clone().token(token.clone()).current_user().await {
            Ok(Some(user)) => {
                let session = HostedSession {
                    user_id: user.id,
                    email: user.email,
                    name: user.name,
                    token,
                };
                *self.session.lock().expect("hosted session lock") = Some(session.clone());
                Ok(Some(session))
            }
            Ok(None) | Err(HostedError::SignInAgain) => {
                let secrets = self.secrets()?;
                blocking_secrets(secrets, |store| store.delete_session_token()).await?;
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// The vault's key material, refusing when there is no vault to unlock.
    async fn vault_material(&self) -> Result<KeyMaterial, HostedError> {
        let collection = self.collection().await?;
        self.key_material(&collection)
            .await?
            .ok_or(HostedError::NoVault)
    }

    /// This account's one collection, claimed if it has none. Claiming is
    /// idempotent on the server and is not entitlement-gated, so an account
    /// that has not paid yet can still reach this far.
    async fn collection(&self) -> Result<String, HostedError> {
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
    async fn key_material(&self, collection: &str) -> Result<Option<KeyMaterial>, HostedError> {
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
    async fn known_material(&self) -> Result<KeyMaterial, HostedError> {
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

    fn remember_material(&self, material: Option<KeyMaterial>) {
        *self.key_material.lock().expect("hosted key material lock") = material;
    }

    /// Writes both envelopes in one request, which is the only shape the
    /// server offers: omitting the recovery fields would delete the recovery
    /// envelope rather than leave it alone (server ADR 0006, rule 2).
    ///
    /// The answer is the **authoritative** material, which is not always what
    /// was sent — a claim that loses a race gets the winner's back.
    async fn put_key_material(
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
    pub(super) async fn keep(&self, vault_key: [u8; KEY_BYTES]) -> Result<(), HostedError> {
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

    pub(super) async fn stored_vault_key(&self) -> Result<Option<[u8; KEY_BYTES]>, HostedError> {
        let secrets = self.secrets()?;
        blocking_secrets(secrets, |store| store.vault_key()).await
    }

    /// Best-effort: a setup with no secret store attached signs in fine, it
    /// just does not remember. Only the steps that must keep a secret refuse.
    pub(super) async fn remember_token(&self, token: &str) {
        if let Some(secrets) = self.secrets.clone() {
            let token = token.to_owned();
            let _ = blocking_secrets(secrets, move |store| store.set_session_token(&token)).await;
        }
    }

    fn secrets(&self) -> Result<Arc<dyn VaultSecrets>, HostedError> {
        self.secrets.clone().ok_or_else(|| {
            HostedError::SecretStore("this device has no secret store attached".into())
        })
    }
}

/// Anything that went wrong in the crypto itself and is not a secret a person
/// can retype: an unreadable envelope, an unsupported KDF, a panicked task.
fn crypto(error: E2eeError) -> HostedError {
    HostedError::Crypto(error.to_string())
}

/// Runs crypto off the async runtime. Argon2id at 64 MiB is tens of
/// milliseconds of solid CPU; on the runtime it would stall every other task.
/// The work's own failure stays inside `T`, so each caller names the one
/// `E2eeError` that is a person's mistake rather than the engine's.
async fn blocking<T, F>(work: F) -> Result<T, HostedError>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| HostedError::Crypto(error.to_string()))
}

/// Same, for the secret store: a keyring read can reach D-Bus and block.
async fn blocking_secrets<T, F>(secrets: Arc<dyn VaultSecrets>, work: F) -> Result<T, HostedError>
where
    T: Send + 'static,
    F: FnOnce(&dyn VaultSecrets) -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(move || work(secrets.as_ref()))
        .await
        .map_err(|error| HostedError::SecretStore(error.to_string()))?
        .map_err(HostedError::SecretStore)
}

//! The hosted setup flow, projected to Swift and Kotlin.
//!
//! The engine owns the sequence (`futo_notes_sync::HostedSetup`); this is a
//! thin projection of it. A native shell calls the steps in the order this
//! object hands them out and does exactly one thing the engine cannot: open a
//! URL in the platform auth sheet.

use std::sync::Arc;

use futo_notes_sync::{self as sync, HostedSetup, VaultSecrets};

use super::SyncClient;

/// Where hosted sync lives. Compiled in, so nobody types a server address; a
/// debug build can point elsewhere. Shells read it rather than holding their
/// own copy.
#[uniffi::export]
pub fn hosted_server_url() -> String {
    sync::hosted_server()
}

/// What a hosted step can fail with. Each variant is a different thing for a
/// person to do about it, which is why they cross as variants and not as one
/// string.
///
/// The sentence-carrying field is `reason`, not `message`: UniFFI renders an
/// error enum as a Kotlin `Exception` subclass, and a `message` field there is
/// an overload-resolution ambiguity against `Throwable.message` that fails the
/// Android build. The desktop contract uses the same word so both shells read
/// one vocabulary.
#[derive(Debug, uniffi::Error, thiserror::Error)]
pub enum HostedError {
    /// The session is gone: show "sign in again". **Not** a vault reset — the
    /// vault key, the object map, and every note stay where they are.
    #[error("sign in again")]
    SignInAgain,
    #[error("not signed in")]
    NotSignedIn,
    /// This server does not offer hosted sync.
    #[error("{reason}")]
    NotHosted { reason: String },
    #[error("too many sign-in attempts")]
    RateLimited { retry_after_seconds: u32 },
    #[error("{reason}")]
    Server { reason: String },
    #[error("{reason}")]
    Network { reason: String },
    /// Creating a vault is an entitlement-gated write: subscribe first.
    #[error("a subscription is required before a vault can be created")]
    NotEntitled,
    /// This account already has a vault. Unlock it rather than replacing it.
    #[error("this account already has a vault; unlock it instead")]
    VaultAlreadyExists,
    #[error("this account has no vault yet")]
    NoVault,
    #[error("a vault password must be at least {minimum} characters")]
    VaultPasswordTooShort { minimum: u32 },
    /// The one failure a person fixes by typing again.
    #[error("that is not this vault's password")]
    WrongVaultPassword,
    /// Not a recovery key at all. Caught on the device.
    #[error("that does not look like a recovery key")]
    RecoveryKeyFormat,
    /// A mistyped or transposed character, caught by the check character
    /// before anything is sent.
    #[error("that recovery key has a typo")]
    RecoveryKeyTypo,
    #[error("that is not this vault's recovery key")]
    WrongRecoveryKey,
    #[error("this vault has no recovery key")]
    NoRecoveryKey,
    /// The OS secret store refused; nothing was kept.
    #[error("{reason}")]
    SecretStore { reason: String },
    #[error("{reason}")]
    Crypto { reason: String },
}

impl From<sync::HostedError> for HostedError {
    fn from(error: sync::HostedError) -> Self {
        match error {
            sync::HostedError::SignInAgain => Self::SignInAgain,
            sync::HostedError::NotSignedIn => Self::NotSignedIn,
            sync::HostedError::NotHosted(reason) => Self::NotHosted { reason },
            sync::HostedError::RateLimited {
                retry_after_seconds,
            } => Self::RateLimited {
                retry_after_seconds,
            },
            sync::HostedError::Server(reason) => Self::Server { reason },
            sync::HostedError::Network(reason) => Self::Network { reason },
            sync::HostedError::NotEntitled => Self::NotEntitled,
            sync::HostedError::VaultAlreadyExists => Self::VaultAlreadyExists,
            sync::HostedError::NoVault => Self::NoVault,
            sync::HostedError::VaultPasswordTooShort { minimum } => {
                Self::VaultPasswordTooShort { minimum }
            }
            sync::HostedError::WrongVaultPassword => Self::WrongVaultPassword,
            sync::HostedError::RecoveryKeyFormat => Self::RecoveryKeyFormat,
            sync::HostedError::RecoveryKeyTypo => Self::RecoveryKeyTypo,
            sync::HostedError::WrongRecoveryKey => Self::WrongRecoveryKey,
            sync::HostedError::NoRecoveryKey => Self::NoRecoveryKey,
            sync::HostedError::SecretStore(reason) => Self::SecretStore { reason },
            sync::HostedError::Crypto(reason) => Self::Crypto { reason },
        }
    }
}

/// What a shell's own secret store can fail with. One variant, because there
/// is one thing to do about any of them: the device did not keep the secret
/// and will ask again.
#[derive(Debug, uniffi::Error, thiserror::Error)]
pub enum SecretStoreError {
    #[error("{reason}")]
    Refused { reason: String },
}

/// Where this device keeps the vault key and the session token: the iOS
/// Keychain, Android's `SecureStore`. The engine names the two secrets; the
/// shell that implements this says where they live, scoped to one notes root.
///
/// A missing entry is `null`, never an error — a device that has not been set
/// up is the ordinary case — and deleting something absent succeeds. These
/// run on Tokio workers and may block; they never touch UI.
#[uniffi::export(callback_interface)]
pub trait VaultSecretStore: Send + Sync {
    fn vault_key(&self) -> Result<Option<Vec<u8>>, SecretStoreError>;
    fn set_vault_key(&self, key: Vec<u8>) -> Result<(), SecretStoreError>;
    fn delete_vault_key(&self) -> Result<(), SecretStoreError>;
    fn session_token(&self) -> Result<Option<String>, SecretStoreError>;
    fn set_session_token(&self, token: String) -> Result<(), SecretStoreError>;
    fn delete_session_token(&self) -> Result<(), SecretStoreError>;
}

/// Adapts a shell's store to the engine's port. The one thing it adds is a
/// length check: a stored key that is not 32 bytes would encrypt notes nothing
/// could read back, so it is an error rather than a silently padded key.
struct ShellSecrets(Arc<dyn VaultSecretStore>);

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
}

fn engine_secrets(store: Box<dyn VaultSecretStore>) -> Arc<dyn VaultSecrets> {
    Arc::new(ShellSecrets(Arc::from(store)))
}

/// Which screen the wizard is on, derived from server facts and this device's
/// secret store — never from a stored position, so quitting halfway and
/// reopening lands on the right screen.
#[derive(uniffi::Enum)]
pub enum SetupStep {
    SignIn,
    Subscribe,
    CreateVault,
    Unlock,
    Ready,
}

impl From<sync::SetupStep> for SetupStep {
    fn from(step: sync::SetupStep) -> Self {
        match step {
            sync::SetupStep::SignIn => Self::SignIn,
            sync::SetupStep::Subscribe => Self::Subscribe,
            sync::SetupStep::CreateVault => Self::CreateVault,
            sync::SetupStep::Unlock => Self::Unlock,
            sync::SetupStep::Ready => Self::Ready,
        }
    }
}

/// The shortest vault password the engine will create a vault with, so a
/// shell's strength meter and its Continue button agree with what Rust does.
#[uniffi::export]
pub fn min_vault_password_length() -> u32 {
    sync::MIN_VAULT_PASSWORD_CHARS as u32
}

/// How the app should log in to a server, read from its capability document.
#[derive(uniffi::Enum)]
pub enum SignInFlow {
    /// Log in with FUTO. `sells_subscriptions` says whether the wizard has a
    /// subscribe step.
    Hosted {
        sells_subscriptions: bool,
    },
    Password,
    Dev,
}

impl From<sync::SignInFlow> for SignInFlow {
    fn from(flow: sync::SignInFlow) -> Self {
        match flow {
            sync::SignInFlow::Hosted {
                sells_subscriptions,
            } => Self::Hosted {
                sells_subscriptions,
            },
            sync::SignInFlow::Password => Self::Password,
            sync::SignInFlow::Dev => Self::Dev,
        }
    }
}

/// Reads a server's capability document and says which sign-in to offer.
#[uniffi::export(async_runtime = "tokio")]
pub async fn probe_sign_in_flow(server_url: String) -> Result<SignInFlow, HostedError> {
    Ok(sync::probe_sign_in_flow(&server_url).await?.into())
}

#[derive(uniffi::Record)]
pub struct HostedSession {
    pub user_id: String,
    pub email: String,
    pub name: String,
    pub token: String,
}

impl From<sync::HostedSession> for HostedSession {
    fn from(session: sync::HostedSession) -> Self {
        Self {
            user_id: session.user_id,
            email: session.email,
            name: session.name,
            token: session.token,
        }
    }
}

/// A minted Login Hand-off: the URL to open, and the ticket to wait on.
#[derive(uniffi::Record)]
pub struct SignInHandoff {
    pub url: String,
    pub ticket: String,
}

#[derive(uniffi::Enum)]
pub enum SignInOutcome {
    SignedIn {
        session: HostedSession,
    },
    /// The auth sheet was dismissed. No error and no half state.
    Cancelled,
    /// Mint a new hand-off and open the URL again.
    Expired,
}

#[derive(uniffi::Record)]
pub struct BillingStatus {
    /// The only field to act on: may this account write right now?
    pub entitled: bool,
    pub state: String,
    pub grace_until: Option<String>,
    pub storage_quota_bytes: u64,
    pub blob_max_bytes: u64,
    pub bytes_used: u64,
}

impl From<sync::BillingStatus> for BillingStatus {
    fn from(status: sync::BillingStatus) -> Self {
        Self {
            entitled: status.entitled,
            state: status.state,
            grace_until: status.grace_until,
            storage_quota_bytes: status.storage_quota_bytes,
            blob_max_bytes: status.blob_max_bytes,
            bytes_used: status.bytes_used,
        }
    }
}

#[derive(uniffi::Enum)]
pub enum Checkout {
    /// Open this in the auth sheet, then `await_entitled`.
    Open { url: String },
    /// Nothing to buy; this account may already write.
    AlreadyEntitled { status: BillingStatus },
}

#[derive(uniffi::Enum)]
pub enum EntitlementOutcome {
    Entitled {
        status: BillingStatus,
    },
    Cancelled,
    /// The wait ran out; `status` is the last reading.
    GaveUp {
        status: BillingStatus,
    },
}

/// One hosted setup attempt.
#[derive(uniffi::Object)]
pub struct HostedSetupClient {
    setup: HostedSetup,
}

#[uniffi::export(async_runtime = "tokio")]
impl HostedSetupClient {
    /// Against the FUTO hosted service. `secrets` is this device's OS secret
    /// store, scoped to the notes root being set up.
    #[uniffi::constructor]
    pub fn hosted(secrets: Box<dyn VaultSecretStore>) -> Result<Arc<Self>, HostedError> {
        Ok(Arc::new(Self {
            setup: HostedSetup::hosted()?.with_secrets(engine_secrets(secrets)),
        }))
    }

    /// Against a named server — a self-hoster running in OIDC mode gets the
    /// same flow.
    #[uniffi::constructor]
    pub fn at(
        server_url: String,
        secrets: Box<dyn VaultSecretStore>,
    ) -> Result<Arc<Self>, HostedError> {
        Ok(Arc::new(Self {
            setup: HostedSetup::at(&server_url)?.with_secrets(engine_secrets(secrets)),
        }))
    }

    pub fn server_url(&self) -> String {
        self.setup.server_url().to_owned()
    }

    pub fn session(&self) -> Option<HostedSession> {
        self.setup.session().map(Into::into)
    }

    /// Mints a Login Hand-off. Open the returned URL, then `await_sign_in`.
    pub async fn begin_sign_in(&self) -> Result<SignInHandoff, HostedError> {
        let handoff = self.setup.begin_sign_in().await?;
        Ok(SignInHandoff {
            url: handoff.url,
            ticket: handoff.ticket,
        })
    }

    /// Waits for the person to finish in the browser. Call `cancel_wait` from
    /// the main thread when the auth sheet is dismissed.
    pub async fn await_sign_in(
        &self,
        handoff: SignInHandoff,
    ) -> Result<SignInOutcome, HostedError> {
        let handoff = sync::SignInHandoff {
            url: handoff.url,
            ticket: handoff.ticket,
        };
        Ok(match self.setup.await_sign_in(&handoff).await? {
            sync::SignInOutcome::SignedIn(session) => SignInOutcome::SignedIn {
                session: session.into(),
            },
            sync::SignInOutcome::Cancelled => SignInOutcome::Cancelled,
            sync::SignInOutcome::Expired => SignInOutcome::Expired,
        })
    }

    /// Stops whichever wait is running.
    pub fn cancel_wait(&self) {
        self.setup.cancel_wait();
    }

    pub async fn billing_status(&self) -> Result<BillingStatus, HostedError> {
        Ok(self.setup.billing_status().await?.into())
    }

    /// A URL for the payment provider's customer portal, opened in the
    /// platform's auth sheet from the account card. Minted per press, so it is
    /// asked for when the button is pressed rather than held.
    pub async fn billing_portal(&self) -> Result<String, HostedError> {
        Ok(self.setup.billing_portal().await?)
    }

    pub async fn begin_checkout(&self) -> Result<Checkout, HostedError> {
        Ok(match self.setup.begin_checkout().await? {
            sync::Checkout::Open { url } => Checkout::Open { url },
            sync::Checkout::AlreadyEntitled(status) => Checkout::AlreadyEntitled {
                status: status.into(),
            },
        })
    }

    /// Which screen to show right now. Safe to call on a cold start, before
    /// anything else: a device that finished setup answers `Ready` and is
    /// never asked for a password again.
    pub async fn current_step(&self) -> Result<SetupStep, HostedError> {
        Ok(self.setup.current_step().await?.into())
    }

    /// Creates the vault and answers with its recovery key, formatted for the
    /// save screen. **This is the only time it exists** — nothing here keeps a
    /// copy, and a second call is refused.
    pub async fn create_vault(&self, vault_password: String) -> Result<String, HostedError> {
        Ok(self.setup.create_vault(&vault_password).await?)
    }

    pub async fn unlock_with_vault_password(
        &self,
        vault_password: String,
    ) -> Result<(), HostedError> {
        Ok(self
            .setup
            .unlock_with_vault_password(&vault_password)
            .await?)
    }

    /// A mistyped character is reported as a typo without anything leaving the
    /// device.
    pub async fn unlock_with_recovery_key(&self, typed: String) -> Result<(), HostedError> {
        Ok(self.setup.unlock_with_recovery_key(&typed).await?)
    }

    /// One action: revoke the session, forget both secrets, and demote this
    /// vault's sync state exactly as disconnect does. The notes stay.
    pub async fn sign_out(&self, sync: Arc<SyncClient>) -> Result<(), HostedError> {
        let (session, root) = sync.parts();
        Ok(self.setup.sign_out(session, root).await?)
    }

    /// Waits for the checkout to make the account entitled.
    pub async fn await_entitled(&self) -> Result<EntitlementOutcome, HostedError> {
        Ok(match self.setup.await_entitled().await? {
            sync::EntitlementOutcome::Entitled(status) => EntitlementOutcome::Entitled {
                status: status.into(),
            },
            sync::EntitlementOutcome::Cancelled => EntitlementOutcome::Cancelled,
            sync::EntitlementOutcome::GaveUp(status) => EntitlementOutcome::GaveUp {
                status: status.into(),
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every engine failure reaches the shells as its own variant. An expired
    /// session especially: folded into a generic error it would read as a
    /// broken vault rather than one trip to the browser.
    #[test]
    fn every_hosted_failure_projects_as_its_own_variant() {
        let projected = |error: sync::HostedError| HostedError::from(error);

        assert!(matches!(
            projected(sync::HostedError::SignInAgain),
            HostedError::SignInAgain
        ));
        assert!(matches!(
            projected(sync::HostedError::NotSignedIn),
            HostedError::NotSignedIn
        ));
        assert!(matches!(
            projected(sync::HostedError::NotHosted("no route".into())),
            HostedError::NotHosted { .. }
        ));
        assert!(matches!(
            projected(sync::HostedError::RateLimited {
                retry_after_seconds: 42
            }),
            HostedError::RateLimited {
                retry_after_seconds: 42
            }
        ));
        assert!(matches!(
            projected(sync::HostedError::Server("boom".into())),
            HostedError::Server { .. }
        ));
        assert!(matches!(
            projected(sync::HostedError::Network("offline".into())),
            HostedError::Network { .. }
        ));
    }

    #[test]
    fn the_sign_in_flow_projects_every_arm() {
        assert!(matches!(
            SignInFlow::from(sync::SignInFlow::Hosted {
                sells_subscriptions: true
            }),
            SignInFlow::Hosted {
                sells_subscriptions: true
            }
        ));
        assert!(matches!(
            SignInFlow::from(sync::SignInFlow::Password),
            SignInFlow::Password
        ));
        assert!(matches!(
            SignInFlow::from(sync::SignInFlow::Dev),
            SignInFlow::Dev
        ));
    }

    /// The billing projection is lossless: a shell renders the account card
    /// from these fields and has no second source for any of them.
    #[test]
    fn the_billing_projection_carries_every_field() {
        let sync::BillingStatus {
            entitled,
            state,
            grace_until,
            storage_quota_bytes,
            blob_max_bytes,
            bytes_used,
        } = sync::BillingStatus {
            entitled: true,
            state: "past_due".into(),
            grace_until: Some("2026-09-22T00:00:00Z".into()),
            storage_quota_bytes: 10_000_000_000,
            blob_max_bytes: 104_857_600,
            bytes_used: 4_210_688,
        };

        let projected = BillingStatus::from(sync::BillingStatus {
            entitled,
            state: state.clone(),
            grace_until: grace_until.clone(),
            storage_quota_bytes,
            blob_max_bytes,
            bytes_used,
        });

        assert_eq!(projected.entitled, entitled);
        assert_eq!(projected.state, state);
        assert_eq!(projected.grace_until, grace_until);
        assert_eq!(projected.storage_quota_bytes, storage_quota_bytes);
        assert_eq!(projected.blob_max_bytes, blob_max_bytes);
        assert_eq!(projected.bytes_used, bytes_used);
    }

    /// A release build's shells get the baked address, never a developer's.
    #[test]
    fn the_hosted_address_is_the_one_the_engine_bakes_in() {
        assert_eq!(hosted_server_url(), sync::hosted_server());
    }

    /// The failures a person acts on differently must not be folded together
    /// on the way out. A wrong vault password, a typo in a recovery key, and
    /// an unpaid account are three different screens.
    #[test]
    fn every_vault_failure_projects_as_its_own_variant() {
        assert!(matches!(
            HostedError::from(sync::HostedError::NotEntitled),
            HostedError::NotEntitled
        ));
        assert!(matches!(
            HostedError::from(sync::HostedError::VaultAlreadyExists),
            HostedError::VaultAlreadyExists
        ));
        assert!(matches!(
            HostedError::from(sync::HostedError::NoVault),
            HostedError::NoVault
        ));
        assert!(matches!(
            HostedError::from(sync::HostedError::VaultPasswordTooShort { minimum: 12 }),
            HostedError::VaultPasswordTooShort { minimum: 12 }
        ));
        assert!(matches!(
            HostedError::from(sync::HostedError::WrongVaultPassword),
            HostedError::WrongVaultPassword
        ));
        assert!(matches!(
            HostedError::from(sync::HostedError::RecoveryKeyFormat),
            HostedError::RecoveryKeyFormat
        ));
        assert!(matches!(
            HostedError::from(sync::HostedError::RecoveryKeyTypo),
            HostedError::RecoveryKeyTypo
        ));
        assert!(matches!(
            HostedError::from(sync::HostedError::WrongRecoveryKey),
            HostedError::WrongRecoveryKey
        ));
        assert!(matches!(
            HostedError::from(sync::HostedError::NoRecoveryKey),
            HostedError::NoRecoveryKey
        ));
        assert!(matches!(
            HostedError::from(sync::HostedError::SecretStore("locked".into())),
            HostedError::SecretStore { .. }
        ));
        assert!(matches!(
            HostedError::from(sync::HostedError::Crypto("bad envelope".into())),
            HostedError::Crypto { .. }
        ));
    }

    #[test]
    fn every_wizard_step_projects() {
        for (engine, projected) in [
            (sync::SetupStep::SignIn, SetupStep::SignIn),
            (sync::SetupStep::Subscribe, SetupStep::Subscribe),
            (sync::SetupStep::CreateVault, SetupStep::CreateVault),
            (sync::SetupStep::Unlock, SetupStep::Unlock),
            (sync::SetupStep::Ready, SetupStep::Ready),
        ] {
            assert_eq!(
                std::mem::discriminant(&SetupStep::from(engine)),
                std::mem::discriminant(&projected),
                "{engine:?} projected to the wrong step"
            );
        }
    }

    /// A shell's store hands back bytes, and a wrong length is caught here
    /// rather than becoming a key that encrypts notes nothing can read.
    #[test]
    fn a_stored_key_of_the_wrong_length_is_refused() {
        struct ShortKey;
        impl VaultSecretStore for ShortKey {
            fn vault_key(&self) -> Result<Option<Vec<u8>>, SecretStoreError> {
                Ok(Some(vec![1, 2, 3]))
            }
            fn set_vault_key(&self, _key: Vec<u8>) -> Result<(), SecretStoreError> {
                Ok(())
            }
            fn delete_vault_key(&self) -> Result<(), SecretStoreError> {
                Ok(())
            }
            fn session_token(&self) -> Result<Option<String>, SecretStoreError> {
                Ok(None)
            }
            fn set_session_token(&self, _token: String) -> Result<(), SecretStoreError> {
                Ok(())
            }
            fn delete_session_token(&self) -> Result<(), SecretStoreError> {
                Ok(())
            }
        }

        let secrets = ShellSecrets(Arc::new(ShortKey));
        assert!(VaultSecrets::vault_key(&secrets)
            .unwrap_err()
            .contains("expected 32"));
    }

    /// The length rule is the engine's, so a shell's Continue button and Rust
    /// cannot disagree about what a long-enough vault password is.
    #[test]
    fn the_minimum_vault_password_length_comes_from_the_engine() {
        assert_eq!(
            min_vault_password_length(),
            sync::MIN_VAULT_PASSWORD_CHARS as u32
        );
    }
}

//! The hosted setup flow, projected to Swift and Kotlin.
//!
//! The engine owns the sequence (`futo_notes_sync::HostedSetup`); this is a
//! thin projection of it. A native shell calls the steps in the order this
//! object hands them out and does exactly one thing the engine cannot: open a
//! URL in the platform auth sheet.

use std::sync::Arc;

use futo_notes_sync::{self as sync, HostedSetup, VaultSecrets};

use super::SyncClient;

mod errors;
mod secrets;
mod types;

pub use errors::{HostedError, SecretStoreError};
use secrets::engine_secrets;
#[cfg(test)]
use secrets::ShellSecrets;
pub use secrets::VaultSecretStore;
pub use types::{
    min_vault_password_length, probe_sign_in_flow, BillingStatus, Checkout, EntitlementOutcome,
    HostedSession, PairingCode, PairingOutcome, PairingRequest, SetupStep, SignInFlow,
    SignInHandoff, SignInOutcome,
};

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

    /// Sets a new vault password, from the account card. Asks for no current
    /// secret: this device already holds the vault key, and a device paired by
    /// QR never knew the old password. The vault key itself does not change,
    /// so every other device carries on untouched.
    ///
    /// `VaultKeyChangedElsewhere` means another device re-wrapped in between;
    /// nothing was overwritten, and calling this again lands.
    pub async fn change_vault_password(&self, new_password: String) -> Result<(), HostedError> {
        Ok(self.setup.change_vault_password(&new_password).await?)
    }

    /// Issues a new recovery key and answers with it, for the same save screen
    /// the wizard uses. **The old key stops working**, and like `create_vault`
    /// nothing here keeps a copy of what it returns.
    pub async fn new_recovery_key(&self) -> Result<String, HostedError> {
        Ok(self.setup.new_recovery_key().await?)
    }

    /// Hands this device's hosted secrets to the sync engine, so cycles can
    /// run. The step after `ready`, whichever door got there, and the mirror
    /// image of `signOut`.
    ///
    /// Safe to call again: connecting an already-connected session rebuilds it
    /// from the same facts, which is what lets a shell call it whenever it
    /// notices an unlocked vault rather than only at the moment it became one.
    /// A device with no vault key is `VaultLocked` and one with no session is
    /// `NotSignedIn` — both mean the wizard is not finished, not that anything
    /// broke.
    pub async fn connect_sync(&self, sync: Arc<SyncClient>) -> Result<(), HostedError> {
        let (session, root) = sync.parts();
        Ok(self.setup.connect_sync(session, root).await?)
    }

    /// Whether this device has a hosted vault to resume, read from its secret
    /// store with **no request of any kind**. What a shell asks at a cold start
    /// before it is willing to spend a round trip — `currentStep` and
    /// `connectSync` both validate the saved token and resolve the collection
    /// over the network, so neither can answer this offline.
    pub async fn has_saved_vault(&self) -> Result<bool, HostedError> {
        Ok(self.setup.has_saved_vault().await?)
    }

    /// One action: revoke the session, forget both secrets, and demote this
    /// vault's sync state exactly as disconnect does. The notes stay.
    pub async fn sign_out(&self, sync: Arc<SyncClient>) -> Result<(), HostedError> {
        let (session, root) = sync.parts();
        Ok(self.setup.sign_out(session, root).await?)
    }

    /// Opens a pairing and returns the code for this device to show as a QR.
    /// Called on the **new** device; follow it with `await_pairing`.
    ///
    /// The one-time keypair's private half stays inside the engine: nothing
    /// hands it to a shell, and it dies with the process.
    pub async fn begin_pairing(&self, device_name: String) -> Result<PairingCode, HostedError> {
        let code = self.setup.begin_pairing(&device_name).await?;
        Ok(PairingCode {
            payload: code.payload,
            expires_at: code.expires_at,
        })
    }

    /// Reads what the camera returned, on the **unlocked** device. Parsing
    /// only: nothing is sent, and no vault key is touched. Show the
    /// confirmation naming `device_name`, then call `confirm_pairing`.
    pub fn complete_pairing(&self, scanned: String) -> Result<Arc<PairingRequest>, HostedError> {
        Ok(Arc::new(PairingRequest(
            self.setup.complete_pairing(&scanned)?,
        )))
    }

    /// The confirm step: seals this device's vault key to the scanned code and
    /// posts it to the relay. The only call that sends a vault key anywhere.
    pub async fn confirm_pairing(&self, request: Arc<PairingRequest>) -> Result<(), HostedError> {
        Ok(self.setup.confirm_pairing(&request.0).await?)
    }

    /// Waits on the **new** device for the other one to answer, then keeps the
    /// key. `Paired` means the vault is unlocked and `current_step` answers
    /// `Ready`. `cancel_wait` ends it from the main thread.
    pub async fn await_pairing(&self) -> Result<PairingOutcome, HostedError> {
        Ok(match self.setup.await_pairing().await? {
            sync::PairingOutcome::Paired => PairingOutcome::Paired,
            sync::PairingOutcome::Cancelled => PairingOutcome::Cancelled,
        })
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

    /// A scanned code reaches a native shell as a handle it cannot build, so
    /// the only way to the relay is through the confirmation sheet.
    #[test]
    fn a_scanned_code_carries_what_the_confirmation_sheet_shows() {
        let client = HostedSetupClient::at(
            "https://pairing.example".into(),
            Box::new(StubSecrets(None)),
        )
        .expect("client");
        // A payload in the engine's own format: 32 bytes of key as unpadded
        // base64url, the version tag, and the two self-reported strings.
        let code = concat!(
            r#"{"futo_notes_pairing":1,"id":"pairing-1","#,
            r#""public_key":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc","#,
            r#""device_name":"Kitchen laptop","platform":"desktop"}"#,
        );

        let request = client.complete_pairing(code.into()).expect("parse");
        assert_eq!(request.device_name(), "Kitchen laptop");
        assert_eq!(request.platform(), "desktop");

        assert!(matches!(
            client.complete_pairing("not a pairing code".into()),
            Err(HostedError::PairingCodeInvalid)
        ));
    }

    /// A secret store holding only a fixed vault key (or none), for the
    /// projections that never write one.
    struct StubSecrets(Option<Vec<u8>>);
    impl VaultSecretStore for StubSecrets {
        fn vault_key(&self) -> Result<Option<Vec<u8>>, SecretStoreError> {
            Ok(self.0.clone())
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
        fn delete_sync_password(&self) -> Result<(), SecretStoreError> {
            Ok(())
        }
    }

    /// A shell's store hands back bytes, and a wrong length is caught here
    /// rather than becoming a key that encrypts notes nothing can read.
    #[test]
    fn a_stored_key_of_the_wrong_length_is_refused() {
        let secrets = ShellSecrets(Arc::new(StubSecrets(Some(vec![1, 2, 3]))));
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

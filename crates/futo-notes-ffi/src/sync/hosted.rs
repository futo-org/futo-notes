//! The hosted setup flow, projected to Swift and Kotlin.
//!
//! The engine owns the sequence (`futo_notes_sync::HostedSetup`); this is a
//! thin projection of it. A native shell calls the steps in the order this
//! object hands them out and does exactly one thing the engine cannot: open a
//! URL in the platform auth sheet.

use std::sync::Arc;

use futo_notes_sync::{self as sync, HostedSetup};

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
        }
    }
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
    /// Against the FUTO hosted service.
    #[uniffi::constructor]
    pub fn hosted() -> Result<Arc<Self>, HostedError> {
        Ok(Arc::new(Self {
            setup: HostedSetup::hosted()?,
        }))
    }

    /// Against a named server — a self-hoster running in OIDC mode gets the
    /// same flow.
    #[uniffi::constructor]
    pub fn at(server_url: String) -> Result<Arc<Self>, HostedError> {
        Ok(Arc::new(Self {
            setup: HostedSetup::at(&server_url)?,
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

    pub async fn begin_checkout(&self) -> Result<Checkout, HostedError> {
        Ok(match self.setup.begin_checkout().await? {
            sync::Checkout::Open { url } => Checkout::Open { url },
            sync::Checkout::AlreadyEntitled(status) => Checkout::AlreadyEntitled {
                status: status.into(),
            },
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
}

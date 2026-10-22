//! The records and enums a hosted setup step hands back to a shell.

use super::*;

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
    off_caller(async move { Ok(sync::probe_sign_in_flow(&server_url).await?.into()) }).await
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

/// What the new device shows: the string to draw as a QR code, and when it
/// stops being scannable.
#[derive(uniffi::Record)]
pub struct PairingCode {
    pub payload: String,
    /// RFC 3339, five minutes from when the code was opened.
    pub expires_at: String,
}

/// A scanned pairing code, parsed and nothing more.
///
/// An **opaque handle on purpose**: a shell reads the name to put on the
/// confirmation sheet and hands the same object back to `confirm_pairing`. It
/// cannot build one, which is what makes the confirmation a real gate rather
/// than a convention — a wrong scan has nothing to send.
#[derive(uniffi::Object)]
pub struct PairingRequest(pub(super) sync::PairingRequest);

#[uniffi::export]
impl PairingRequest {
    /// What the new device calls itself. Self-reported by that device and
    /// shown verbatim on the confirmation sheet.
    pub fn device_name(&self) -> String {
        self.0.device_name().to_owned()
    }

    /// `ios`, `android`, or `desktop`.
    pub fn platform(&self) -> String {
        self.0.platform().to_owned()
    }
}

/// How waiting for the other device ended. An expired or refused pairing is an
/// error, because each is something to tell the person; these two are not.
#[derive(uniffi::Enum)]
pub enum PairingOutcome {
    /// The key arrived and is kept. This device is unlocked.
    Paired,
    /// The pairing screen was left. Nothing was kept.
    Cancelled,
}

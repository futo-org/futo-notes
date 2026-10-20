//! Hosted setup wire shapes: every outcome is a tagged union, never a bare string.

use serde::{Deserialize, Serialize};

// ── Hosted sync setup ─────────────────────────────────────────────────────
//
// The engine owns the sequence (`futo_notes_sync::HostedSetup`); these are its
// wire shapes. Every outcome is a tagged union rather than a bare string, so
// the frontend branches on a `kind` the same way it does for an open-note
// disposition.

/// How the app should log in to a server, read from its capability document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum SignInFlowOutput {
    #[serde(rename_all = "camelCase")]
    Hosted {
        /// Whether this deployment sells subscriptions, and therefore whether
        /// the wizard has a subscribe step.
        sells_subscriptions: bool,
    },
    Password,
    Dev,
}

impl From<futo_notes_sync::SignInFlow> for SignInFlowOutput {
    fn from(flow: futo_notes_sync::SignInFlow) -> Self {
        use futo_notes_sync::SignInFlow;
        match flow {
            SignInFlow::Hosted {
                sells_subscriptions,
            } => Self::Hosted {
                sells_subscriptions,
            },
            SignInFlow::Password => Self::Password,
            SignInFlow::Dev => Self::Dev,
        }
    }
}

/// A minted Login Hand-off. `url` goes to the system browser; `handoff` comes
/// back to `e2ee_hosted_await_sign_in` unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignInHandoffOutput {
    pub(crate) url: String,
    pub(crate) ticket: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostedSessionOutput {
    pub(crate) user_id: String,
    pub(crate) email: String,
    pub(crate) name: String,
    pub(crate) token: String,
}

impl From<futo_notes_sync::HostedSession> for HostedSessionOutput {
    fn from(session: futo_notes_sync::HostedSession) -> Self {
        Self {
            user_id: session.user_id,
            email: session.email,
            name: session.name,
            token: session.token,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum SignInOutcomeOutput {
    SignedIn {
        session: HostedSessionOutput,
    },
    /// The browser window was abandoned. No error and no half state.
    Cancelled,
    /// Mint a new hand-off and open the URL again.
    Expired,
}

impl From<futo_notes_sync::SignInOutcome> for SignInOutcomeOutput {
    fn from(outcome: futo_notes_sync::SignInOutcome) -> Self {
        use futo_notes_sync::SignInOutcome;
        match outcome {
            SignInOutcome::SignedIn(session) => Self::SignedIn {
                session: session.into(),
            },
            SignInOutcome::Cancelled => Self::Cancelled,
            SignInOutcome::Expired => Self::Expired,
        }
    }
}

/// What the account card reads. `entitled` is the only field to act on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct BillingStatusOutput {
    pub(crate) entitled: bool,
    pub(crate) state: String,
    pub(crate) grace_until: Option<String>,
    pub(crate) storage_quota_bytes: u64,
    pub(crate) blob_max_bytes: u64,
    pub(crate) bytes_used: u64,
}

impl From<futo_notes_sync::BillingStatus> for BillingStatusOutput {
    fn from(status: futo_notes_sync::BillingStatus) -> Self {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum CheckoutOutput {
    /// Open this in the browser, then await entitlement.
    Open { url: String },
    /// Nothing to buy; this account may already write.
    AlreadyEntitled { status: BillingStatusOutput },
}

impl From<futo_notes_sync::Checkout> for CheckoutOutput {
    fn from(checkout: futo_notes_sync::Checkout) -> Self {
        use futo_notes_sync::Checkout;
        match checkout {
            Checkout::Open { url } => Self::Open { url },
            Checkout::AlreadyEntitled(status) => Self::AlreadyEntitled {
                status: status.into(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum EntitlementOutcomeOutput {
    Entitled {
        status: BillingStatusOutput,
    },
    Cancelled,
    /// The wait ran out; `status` is the last reading.
    GaveUp {
        status: BillingStatusOutput,
    },
}

impl From<futo_notes_sync::EntitlementOutcome> for EntitlementOutcomeOutput {
    fn from(outcome: futo_notes_sync::EntitlementOutcome) -> Self {
        use futo_notes_sync::EntitlementOutcome;
        match outcome {
            EntitlementOutcome::Entitled(status) => Self::Entitled {
                status: status.into(),
            },
            EntitlementOutcome::Cancelled => Self::Cancelled,
            EntitlementOutcome::GaveUp(status) => Self::GaveUp {
                status: status.into(),
            },
        }
    }
}

/// What the new device shows. `payload` is the string to draw as a QR code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingCodeOutput {
    pub(crate) payload: String,
    /// RFC 3339, five minutes from when the code was opened.
    pub(crate) expires_at: String,
}

/// What a scanned code says, for the confirmation sheet — and **only** that.
///
/// The pairing id and the public key stay in Rust: the frontend reads the name
/// here and calls `e2ee_hosted_confirm_pairing`, which acts on the scan Rust
/// is holding. Nothing the frontend can send reaches the relay, so a wrong
/// scan has nothing to post (parent spec user story 16).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScannedPairingOutput {
    pub(crate) device_name: String,
    /// `ios`, `android`, or `desktop`.
    pub(crate) platform: String,
}

impl From<&futo_notes_sync::PairingRequest> for ScannedPairingOutput {
    fn from(request: &futo_notes_sync::PairingRequest) -> Self {
        Self {
            device_name: request.device_name().to_owned(),
            platform: request.platform().to_owned(),
        }
    }
}

/// How waiting for the other device ended. An expired or refused pairing is an
/// error instead, because each is something to tell the person.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum PairingOutcomeOutput {
    /// The key arrived and is kept. This device is unlocked.
    Paired,
    /// The pairing screen was left. Nothing was kept.
    Cancelled,
}

impl From<futo_notes_sync::PairingOutcome> for PairingOutcomeOutput {
    fn from(outcome: futo_notes_sync::PairingOutcome) -> Self {
        use futo_notes_sync::PairingOutcome;
        match outcome {
            PairingOutcome::Paired => Self::Paired,
            PairingOutcome::Cancelled => Self::Cancelled,
        }
    }
}

/// Why a hosted step failed, as a variant rather than a sentence: each one is
/// a different thing for a person to do about it, and `signInAgain` in
/// particular must never be rendered as a broken vault. The sentence-carrying
/// field is `reason`, matching the name the native contract is forced into (a
/// `message` on a UniFFI error collides with `Throwable.message` in Kotlin), so
/// all three shells read one vocabulary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum HostedErrorOutput {
    /// The session is gone. Sign in again; sync state is untouched.
    SignInAgain,
    NotSignedIn,
    /// This server does not offer hosted sync.
    NotHosted {
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    RateLimited {
        retry_after_seconds: u32,
    },
    Server {
        reason: String,
    },
    Network {
        reason: String,
    },
    /// Creating a vault is an entitlement-gated write: subscribe first.
    NotEntitled,
    /// This account already has a vault. Unlock it rather than replacing it.
    VaultAlreadyExists,
    NoVault,
    VaultPasswordTooShort {
        minimum: u32,
    },
    /// The one failure a person fixes by typing again.
    WrongVaultPassword,
    /// Not a recovery key at all; caught on the device.
    RecoveryKeyFormat,
    /// A mistyped or transposed character, caught by the check character
    /// before anything is sent.
    RecoveryKeyTypo,
    WrongRecoveryKey,
    NoRecoveryKey,
    /// Another device re-wrapped this vault's key material in between. Read
    /// again and retry; nothing was overwritten and nothing is half-written.
    VaultKeyChangedElsewhere,
    /// The OS secret store refused; nothing was kept.
    SecretStore {
        reason: String,
    },
    Crypto {
        reason: String,
    },
    /// What was scanned is not a FUTO Notes pairing code. Caught on the
    /// device, with nothing sent.
    PairingCodeInvalid,
    /// The relay will not serve this pairing — unknown, expired, already
    /// collected, or another account's. The server answers all four alike, so
    /// neither does this.
    PairingRefused,
    /// A key has already been posted to this pairing. Not retryable; show a
    /// new code.
    PairingAlreadyKeyed,
    /// The pairing window closed with no key delivered.
    PairingExpired,
    /// No pairing in flight: no code being shown, and no scanned code waiting
    /// on a confirmation. A step ran out of order; nothing was sent.
    PairingNotStarted,
    /// A locked device cannot hand the vault key to another one.
    VaultLocked,
}

/// Which screen the hosted wizard is on, derived from server facts and this
/// device's secret store — never from a stored position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum SetupStepOutput {
    SignIn,
    Subscribe,
    CreateVault,
    Unlock,
    Ready,
}

impl From<futo_notes_sync::SetupStep> for SetupStepOutput {
    fn from(step: futo_notes_sync::SetupStep) -> Self {
        use futo_notes_sync::SetupStep;
        match step {
            SetupStep::SignIn => Self::SignIn,
            SetupStep::Subscribe => Self::Subscribe,
            SetupStep::CreateVault => Self::CreateVault,
            SetupStep::Unlock => Self::Unlock,
            SetupStep::Ready => Self::Ready,
        }
    }
}

impl From<futo_notes_sync::HostedError> for HostedErrorOutput {
    fn from(error: futo_notes_sync::HostedError) -> Self {
        use futo_notes_sync::HostedError;
        match error {
            HostedError::SignInAgain => Self::SignInAgain,
            HostedError::NotSignedIn => Self::NotSignedIn,
            HostedError::NotHosted(reason) => Self::NotHosted { reason },
            HostedError::RateLimited {
                retry_after_seconds,
            } => Self::RateLimited {
                retry_after_seconds,
            },
            HostedError::Server(reason) => Self::Server { reason },
            HostedError::Network(reason) => Self::Network { reason },
            HostedError::NotEntitled => Self::NotEntitled,
            HostedError::VaultAlreadyExists => Self::VaultAlreadyExists,
            HostedError::NoVault => Self::NoVault,
            HostedError::VaultPasswordTooShort { minimum } => {
                Self::VaultPasswordTooShort { minimum }
            }
            HostedError::WrongVaultPassword => Self::WrongVaultPassword,
            HostedError::RecoveryKeyFormat => Self::RecoveryKeyFormat,
            HostedError::RecoveryKeyTypo => Self::RecoveryKeyTypo,
            HostedError::WrongRecoveryKey => Self::WrongRecoveryKey,
            HostedError::NoRecoveryKey => Self::NoRecoveryKey,
            HostedError::VaultKeyChangedElsewhere => Self::VaultKeyChangedElsewhere,
            HostedError::SecretStore(reason) => Self::SecretStore { reason },
            HostedError::Crypto(reason) => Self::Crypto { reason },
            HostedError::PairingCodeInvalid => Self::PairingCodeInvalid,
            HostedError::PairingRefused => Self::PairingRefused,
            HostedError::PairingAlreadyKeyed => Self::PairingAlreadyKeyed,
            HostedError::PairingExpired => Self::PairingExpired,
            HostedError::PairingNotStarted => Self::PairingNotStarted,
            HostedError::VaultLocked => Self::VaultLocked,
        }
    }
}

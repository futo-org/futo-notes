//! The errors a hosted setup step can return across the boundary.

use super::*;

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
    /// Another device re-wrapped this vault's key material in between. Read
    /// again and retry; nothing was overwritten and nothing is half-written.
    #[error("this vault's key changed on another device; try again")]
    VaultKeyChangedElsewhere,
    /// The OS secret store refused; nothing was kept.
    #[error("{reason}")]
    SecretStore { reason: String },
    #[error("{reason}")]
    Crypto { reason: String },
    /// What was scanned is not a FUTO Notes pairing code. Caught on the
    /// device, with nothing sent.
    #[error("that is not a FUTO Notes pairing code")]
    PairingCodeInvalid,
    /// The relay will not serve this pairing — unknown, expired, already
    /// collected, or another account's. The server answers all four alike, so
    /// neither does this.
    #[error("that pairing code is no longer valid; show a new one")]
    PairingRefused,
    /// A key has already been posted to this pairing. Not retryable; show a
    /// new code.
    #[error("another device has already answered this pairing code")]
    PairingAlreadyKeyed,
    /// The pairing window closed with no key delivered.
    #[error("that pairing code expired; show a new one")]
    PairingExpired,
    /// No pairing in flight: no code being shown, and no scanned code waiting
    /// on a confirmation. A step ran out of order; nothing was sent.
    #[error("no pairing is in progress on this device")]
    PairingNotStarted,
    /// A locked device cannot hand the vault key to another one.
    #[error("this device does not hold the vault key")]
    VaultLocked,
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
            sync::HostedError::VaultKeyChangedElsewhere => Self::VaultKeyChangedElsewhere,
            sync::HostedError::SecretStore(reason) => Self::SecretStore { reason },
            sync::HostedError::Crypto(reason) => Self::Crypto { reason },
            sync::HostedError::PairingCodeInvalid => Self::PairingCodeInvalid,
            sync::HostedError::PairingRefused => Self::PairingRefused,
            sync::HostedError::PairingAlreadyKeyed => Self::PairingAlreadyKeyed,
            sync::HostedError::PairingExpired => Self::PairingExpired,
            sync::HostedError::PairingNotStarted => Self::PairingNotStarted,
            sync::HostedError::VaultLocked => Self::VaultLocked,
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

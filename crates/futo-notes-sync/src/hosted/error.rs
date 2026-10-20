//! What a hosted request can fail with.

/// What a hosted request can fail with.
///
/// These cross the UniFFI boundary and the Tauri boundary as the variants they
/// are, because each one is a different thing for a person to do about it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HostedError {
    /// The session is gone. Sign in again — and **only** that. An expired
    /// hosted session is not a wrong password and not a vault reset: the
    /// vault key, the object map, the pull cursor, and every note stay
    /// exactly where they are (ADR 0003; parent spec user story 22).
    #[error("sign in again")]
    SignInAgain,
    /// A step that needs a session ran before one existed.
    #[error("not signed in")]
    NotSignedIn,
    /// This server does not offer the hosted route that was asked for — a
    /// self-hosted deployment, or one older than the hosted service.
    #[error("{0}")]
    NotHosted(String),
    /// Minting hand-off tickets is rate limited. `retry_after_seconds` is the
    /// server's own `Retry-After`, or `0` when it sent none.
    #[error("too many sign-in attempts; retry in {retry_after_seconds}s")]
    RateLimited { retry_after_seconds: u32 },
    /// The server answered, but not with something usable.
    #[error("{0}")]
    Server(String),
    /// Nothing reached the server — no route, no DNS, a refused connection, a
    /// timeout, or an address that is not a usable http(s) URL in the first
    /// place. The engine folds an unusable address in here for the same reason
    /// password mode folds it into its transport error: the sentence says
    /// which, and no caller acts differently on the two.
    #[error("{0}")]
    Network(String),
    /// Creating a vault is an entitlement-gated write, so an account that has
    /// not subscribed is refused here rather than at the first note. This is
    /// the `402` the server answers `PUT /api/collections/{id}/key` with.
    #[error("a subscription is required before a vault can be created")]
    NotEntitled,
    /// This account already has key material. Writing a second vault key would
    /// leave every note already stored encrypted under a key nothing holds, so
    /// the answer is to unlock rather than to create.
    #[error("this account already has a vault; unlock it instead")]
    VaultAlreadyExists,
    /// There is nothing to unlock: this account has no vault yet.
    #[error("this account has no vault yet")]
    NoVault,
    /// A vault password shorter than [`MIN_VAULT_PASSWORD_CHARS`].
    #[error("a vault password must be at least {minimum} characters")]
    VaultPasswordTooShort { minimum: u32 },
    /// The vault password did not open the vault. Distinct from every other
    /// failure because it is the one a person fixes by typing again.
    #[error("that is not this vault's password")]
    WrongVaultPassword,
    /// What was typed is not a recovery key at all — wrong length, or a
    /// character outside the alphabet. Never reaches the network.
    #[error("that does not look like a recovery key")]
    RecoveryKeyFormat,
    /// The check character disagrees with the rest: a mistyped or transposed
    /// character, named as a typo rather than as a wrong key, and caught
    /// before anything is sent (parent spec user story 18).
    #[error("that recovery key has a typo")]
    RecoveryKeyTypo,
    /// A well-formed recovery key that this vault's recovery envelope does not
    /// open — a real key, for some other vault.
    #[error("that is not this vault's recovery key")]
    WrongRecoveryKey,
    /// This vault was created without a recovery envelope, so the recovery
    /// door does not exist for it.
    #[error("this vault has no recovery key")]
    NoRecoveryKey,
    /// Another device re-wrapped this vault's key material between the read
    /// this device is holding and its own write, so the write was refused
    /// rather than silently overwriting that change. Nothing was sent twice
    /// and nothing is half-written: read again and retry, which is what the
    /// next call does on its own.
    #[error("this vault's key changed on another device; try again")]
    VaultKeyChangedElsewhere,
    /// The OS secret store refused. Nothing was kept, so this device would ask
    /// again on its next start.
    #[error("{0}")]
    SecretStore(String),
    /// Wrapping or unwrapping failed for a reason no secret a person could
    /// type would change.
    #[error("{0}")]
    Crypto(String),
    /// What was scanned is not a FUTO Notes pairing code — another app's QR
    /// code, a damaged read, or a payload from a version this build does not
    /// speak. Caught on the device, with nothing sent (parent spec user story
    /// 16: a wrong scan sends nothing).
    #[error("that is not a FUTO Notes pairing code")]
    PairingCodeInvalid,
    /// The relay will not serve this pairing: unknown, expired, already
    /// collected, or belonging to another account. The server answers all four
    /// with one identical body so that a pairing id cannot be probed from
    /// another account, and this client does not pretend to tell them apart
    /// (server ADR 0008).
    #[error("that pairing code is no longer valid; show a new one")]
    PairingRefused,
    /// A key has already been posted to this pairing. Not retryable: a sealed
    /// box is nondeterministic, so a repeated post carries different bytes and
    /// the server has nothing to match it against. Start a new pairing.
    #[error("another device has already answered this pairing code")]
    PairingAlreadyKeyed,
    /// The five-minute window closed with no key delivered. A person who
    /// declined on the other device sends nothing, so declining and walking
    /// away reach the waiting device the same way.
    #[error("that pairing code expired; show a new one")]
    PairingExpired,
    /// There is no pairing in flight on this device: no code being shown, and
    /// no scanned code waiting on a confirmation. Both sides of pairing share
    /// this, because both mean the same thing — a step ran out of order, and
    /// nothing was sent.
    #[error("no pairing is in progress on this device")]
    PairingNotStarted,
    /// A device that does not hold the vault key cannot hand it to another
    /// one. The scanning side of pairing is by definition the unlocked side.
    #[error("this device does not hold the vault key")]
    VaultLocked,
}

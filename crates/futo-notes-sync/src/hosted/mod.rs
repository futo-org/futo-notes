//! Hosted sync setup: Log in with FUTO, read billing, subscribe.
//!
//! [`HostedSetup`] owns the whole sequence. A shell calls the steps in the
//! order this type hands them out, and the only thing it does that Rust
//! cannot is open a URL in a browser or auth sheet — there is no ordering rule
//! for three shells to each remember, and no deep link, URL scheme, or return
//! redirect anywhere in it (ADR 0003, decisions 1 and 11).
//!
//! The wire this drives is the sync server's hosted contract: `POST
//! /api/auth/handoff` and its poll, `GET /api/billing`,
//! `POST /api/billing/checkout`, `GET /api/billing/portal`, and the
//! account-scoped pairing relay (`POST /api/pairings`, its key post, and its
//! poll — server ADR 0008).

mod address;
mod capability;
mod pairing;
mod poll;
mod secrets;
#[cfg(test)]
mod tests;
mod vault;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tokio::sync::Notify;

use crate::server::{HandoffPoll, Http};

pub use address::{hosted_server, HOSTED_SERVER};
pub use capability::{probe_sign_in_flow, SignInFlow};
pub use pairing::{PairingCode, PairingOutcome, PairingRequest};
pub use poll::PollSchedule;
pub use secrets::VaultSecrets;
pub use vault::{SetupStep, MIN_VAULT_PASSWORD_CHARS};

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

/// Who is signed in, and the token that proves it.
///
/// The token slides: it expires 90 days after the session's last
/// authenticated request, so a device that syncs at least that often never
/// visits a browser again (server ADR 0007).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedSession {
    pub user_id: String,
    pub email: String,
    pub name: String,
    pub token: String,
}

/// A minted Login Hand-off: the URL for a browser, and the ticket to wait on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInHandoff {
    /// Open this in the platform auth sheet or the system browser. Nothing
    /// returns to the app through it; [`HostedSetup::await_sign_in`] is how
    /// the app learns the outcome.
    pub url: String,
    /// Claimable for ten minutes from minting.
    pub ticket: String,
}

/// How waiting for a sign-in ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInOutcome {
    /// The person finished in the browser. The setup now holds the session.
    SignedIn(HostedSession),
    /// The app stopped waiting — the auth sheet was dismissed. No error and
    /// no half state: mint a new hand-off whenever the person tries again.
    Cancelled,
    /// The ticket is gone: expired, already redeemed, or an identity the
    /// server turned away. Mint a new hand-off and open the URL again.
    Expired,
}

/// The account's entitlement, the plan it is entitled to, and what it stores.
///
/// `entitled` is the only field to act on — it says whether writes will be
/// accepted right now. `state` is the payment provider's own word behind that
/// answer, carried verbatim for a shell to render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BillingStatus {
    pub entitled: bool,
    /// `none`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`,
    /// `paused`, `incomplete`, `incomplete_expired`.
    pub state: String,
    /// When a past-due account stops being entitled (RFC 3339), else `None`.
    pub grace_until: Option<String>,
    pub storage_quota_bytes: u64,
    pub blob_max_bytes: u64,
    pub bytes_used: u64,
}

/// What starting a checkout produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checkout {
    /// Open this in a browser, then [`HostedSetup::await_entitled`].
    Open { url: String },
    /// The account may already write, so there is nothing to buy. Sending it
    /// to pay again would open a second subscription.
    AlreadyEntitled(BillingStatus),
}

/// How waiting for the account to become entitled ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntitlementOutcome {
    /// The account may write. Carry on with the wizard.
    Entitled(BillingStatus),
    /// The app stopped waiting — the checkout sheet was dismissed.
    Cancelled,
    /// The wait ran out with the account still not entitled. The last status
    /// read is carried so a shell can say which state it is in rather than
    /// only that nothing happened.
    GaveUp(BillingStatus),
}

/// How a wait ended, before it is named in the caller's own words.
enum Waited<T> {
    Got(T),
    Cancelled,
    GaveUp,
}

/// The hosted setup sequence, from the first tap to a subscribed account.
///
/// One instance holds one attempt's session. Steps are safe to call again:
/// re-minting a hand-off is a new ticket, and reading billing or starting a
/// checkout is idempotent on the server's side.
pub struct HostedSetup {
    server_url: String,
    /// Built once and cloned per call, so every step shares one connection
    /// pool instead of opening a socket per poll.
    http: Http,
    session: Mutex<Option<HostedSession>>,
    /// This account's one collection, once resolved. Cached because every
    /// vault step needs it and claiming it is idempotent, not because the
    /// wizard remembers anything: it is re-resolved by a fresh setup.
    collection_id: Mutex<Option<String>>,
    /// Where this device keeps the vault key and the session token. Absent on
    /// a setup built only to probe or sign in.
    secrets: Option<std::sync::Arc<dyn VaultSecrets>>,
    /// The vault's key material as this device last saw it, holding the
    /// revision token that read came with. A re-wrap is guarded by the
    /// revision the *person* was looking at when they pressed the button —
    /// re-reading at the moment of the write instead would quietly overwrite a
    /// change another device made while they were typing.
    key_material: Mutex<Option<futo_notes_core::e2ee::KeyMaterial>>,

    /// The pairing this device is showing a code for, if any: its one-time
    /// keypair and the relay id. In memory only, for the few minutes a code
    /// lives — the private half never reaches disk, a shell, or a log.
    pairing: Mutex<Option<pairing::PendingPairing>>,
    sign_in_schedule: PollSchedule,
    entitlement_schedule: PollSchedule,
    cancelled: AtomicBool,
    cancel: Notify,
}

impl HostedSetup {
    /// Against the FUTO hosted service. The address is compiled in; see
    /// [`hosted_server`].
    pub fn hosted() -> Result<Self, HostedError> {
        Self::at(&hosted_server())
    }

    /// Against a named server. A self-hosted deployment running in OIDC mode
    /// gets the same hand-off, which is why this exists alongside
    /// [`HostedSetup::hosted`]. An address that is not a usable http(s) URL
    /// fails here, before any request, as [`HostedError::Network`].
    pub fn at(server: &str) -> Result<Self, HostedError> {
        let http = Http::new(server).map_err(|error| HostedError::Network(error.message))?;
        Ok(Self {
            server_url: server.trim().trim_end_matches('/').to_owned(),
            http,
            session: Mutex::new(None),
            collection_id: Mutex::new(None),
            key_material: Mutex::new(None),
            secrets: None,
            pairing: Mutex::new(None),
            sign_in_schedule: PollSchedule::SIGN_IN,
            entitlement_schedule: PollSchedule::ENTITLEMENT,
            cancelled: AtomicBool::new(false),
            cancel: Notify::new(),
        })
    }

    /// Replaces the poll schedules. Exists for tests, which drive the real
    /// waits against a real server and cannot spend ten minutes doing it; the
    /// shipped schedules are the defaults on [`PollSchedule`].
    pub fn with_schedules(mut self, sign_in: PollSchedule, entitlement: PollSchedule) -> Self {
        self.sign_in_schedule = sign_in;
        self.entitlement_schedule = entitlement;
        self
    }

    pub fn server_url(&self) -> &str {
        &self.server_url
    }

    /// The session this setup is holding, once sign-in has produced one.
    pub fn session(&self) -> Option<HostedSession> {
        self.session.lock().expect("hosted session lock").clone()
    }

    /// Stops whichever wait is running, promptly. Safe to call when nothing
    /// is waiting: the next wait clears the flag before it starts.
    pub fn cancel_wait(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.cancel.notify_waiters();
    }

    /// Step 1: mint a Login Hand-off. Takes no credentials. Open the returned
    /// URL, then call [`HostedSetup::await_sign_in`] with the same handoff.
    pub async fn begin_sign_in(&self) -> Result<SignInHandoff, HostedError> {
        self.http.mint_handoff().await
    }

    /// Step 2: poll the ticket, backing off, until the person finishes in the
    /// browser, the app cancels, or the ticket is gone.
    pub async fn await_sign_in(
        &self,
        handoff: &SignInHandoff,
    ) -> Result<SignInOutcome, HostedError> {
        let ticket = handoff.ticket.clone();
        let waited = self
            .wait(self.sign_in_schedule, || async {
                match self.http.redeem_handoff(&ticket).await? {
                    HandoffPoll::Pending => Ok(None),
                    HandoffPoll::Session(session) => Ok(Some(Some(session))),
                    HandoffPoll::Gone => Ok(Some(None)),
                }
            })
            .await?;
        Ok(match waited {
            Waited::Got(Some(session)) => {
                // Kept before the caller sees it, so quitting the app on the
                // very next screen still reopens signed in.
                self.remember_token(&session.token).await;
                *self.session.lock().expect("hosted session lock") = Some(session.clone());
                SignInOutcome::SignedIn(session)
            }
            Waited::Got(None) => SignInOutcome::Expired,
            Waited::Cancelled => SignInOutcome::Cancelled,
            // The wait outlives the ticket, so running out of patience and the
            // ticket running out are the same fact: mint a new one.
            Waited::GaveUp => SignInOutcome::Expired,
        })
    }

    /// The account's entitlement, plan, and storage use.
    pub async fn billing_status(&self) -> Result<BillingStatus, HostedError> {
        self.authorized().await?.billing().await
    }

    /// Starts a subscription. An account that may already write gets its
    /// billing status back instead of a URL — paying twice is not a thing a
    /// shell should be able to do by calling this at the wrong moment.
    pub async fn begin_checkout(&self) -> Result<Checkout, HostedError> {
        self.authorized().await?.checkout().await
    }

    /// The payment provider's customer portal, as a URL to open in a browser.
    ///
    /// Read-only from this app's side: invoices, cancellation, and card
    /// changes all happen there, and nothing about the answer is kept (ADR
    /// 0003, decision 8). Each call mints a fresh one-shot URL, so it is
    /// asked for at the moment a person presses the button rather than held
    /// alongside the billing status.
    pub async fn billing_portal(&self) -> Result<String, HostedError> {
        self.authorized().await?.billing_portal().await
    }

    /// Polls billing until the account may write, the app cancels, or the
    /// wait runs out. Entitlement moves when the payment provider's webhook
    /// lands, which is why nothing about the checkout itself can be trusted
    /// to say whether payment succeeded.
    pub async fn await_entitled(&self) -> Result<EntitlementOutcome, HostedError> {
        let http = self.authorized().await?;
        let last = Mutex::new(None);
        let waited = self
            .wait(self.entitlement_schedule, || async {
                let status = http.billing().await?;
                let entitled = status.entitled;
                *last.lock().expect("billing status lock") = Some(status.clone());
                Ok(entitled.then_some(status))
            })
            .await?;
        Ok(match waited {
            Waited::Got(status) => EntitlementOutcome::Entitled(status),
            Waited::Cancelled => EntitlementOutcome::Cancelled,
            Waited::GaveUp => EntitlementOutcome::GaveUp(
                last.lock()
                    .expect("billing status lock")
                    .clone()
                    .expect("a wait that gave up has read billing at least once"),
            ),
        })
    }

    /// The HTTP client carrying this setup's session token, adopting the one
    /// this device saved when the attempt has none of its own. Every step
    /// that needs a session goes through here, which is why a cold start
    /// resumes without a prompt rather than only [`HostedSetup::current_step`]
    /// knowing how to.
    pub(crate) async fn authorized(&self) -> Result<Http, HostedError> {
        let token = self
            .restored_session()
            .await?
            .map(|session| session.token)
            .ok_or(HostedError::NotSignedIn)?;
        Ok(self.http.clone().token(token))
    }

    /// Runs `step` until it answers, the app cancels, or the schedule runs
    /// out. `step` returns `None` to mean "still waiting".
    async fn wait<T, F, Fut>(
        &self,
        schedule: PollSchedule,
        step: F,
    ) -> Result<Waited<T>, HostedError>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<Option<T>, HostedError>>,
    {
        // A cancel that arrived while nothing was waiting must not kill this
        // wait before its first poll.
        self.cancelled.store(false, Ordering::SeqCst);
        let deadline = std::time::Instant::now() + schedule.give_up_after;
        let mut interval = schedule.first;
        loop {
            if self.cancelled.load(Ordering::SeqCst) {
                return Ok(Waited::Cancelled);
            }
            if let Some(value) = step().await? {
                return Ok(Waited::Got(value));
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return Ok(Waited::GaveUp);
            }
            let nap = interval.min(deadline - now);
            tokio::select! {
                _ = tokio::time::sleep(nap) => {}
                _ = self.cancel.notified() => return Ok(Waited::Cancelled),
            }
            interval = schedule.next(interval);
        }
    }
}

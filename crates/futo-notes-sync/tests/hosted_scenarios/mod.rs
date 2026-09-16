//! The hosted-setup scenarios, written once and run twice: against the
//! in-test stub (`tests/hosted_setup.rs`, which is what CI gets) and against a
//! real server in stand-in test mode (`tests/server_integration.rs`, gated on
//! `FUTO_TEST_SERVER`).
//!
//! They drive the public surface a shell would call and assert on what a
//! person would observe — which step the flow reached, whether the account may
//! write — never on HTTP call order or state-machine internals.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futo_notes_sync::{
    probe_sign_in_flow, BillingStatus, Checkout, EntitlementOutcome, HostedError, HostedSetup,
    PairingOutcome, PollSchedule, SetupStep, SignInFlow, SignInOutcome, SyncSession, VaultSecrets,
};

/// Both waits, shrunk so a test spends milliseconds where a person spends
/// minutes. The give-up stays long enough that a slow real server is not
/// mistaken for a person who walked away.
fn setup(base: &str) -> Arc<HostedSetup> {
    let schedule = PollSchedule {
        first: Duration::from_millis(20),
        max: Duration::from_millis(60),
        give_up_after: Duration::from_secs(20),
    };
    Arc::new(
        HostedSetup::at(base)
            .expect("hosted setup")
            .with_schedules(schedule, schedule),
    )
}

/// One device's OS secret store, in memory.
///
/// It also keeps every value ever written, which is how a test can assert the
/// negative that matters most here: the vault password is not among them
/// (ADR 0003, decision 4).
#[derive(Default)]
pub struct DeviceSecrets {
    vault_key: Mutex<Option<[u8; 32]>>,
    token: Mutex<Option<String>>,
    written: Mutex<Vec<String>>,
}

impl DeviceSecrets {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn held_vault_key(&self) -> Option<[u8; 32]> {
        *self.vault_key.lock().unwrap()
    }

    fn held_token(&self) -> Option<String> {
        self.token.lock().unwrap().clone()
    }

    /// Everything this device ever wrote to its secret store.
    fn everything_written(&self) -> Vec<String> {
        self.written.lock().unwrap().clone()
    }

    /// A device that signed in but never unlocked — or one whose key was
    /// forgotten — while its saved session stays good.
    fn forget_vault_key(&self) {
        *self.vault_key.lock().unwrap() = None;
    }
}

impl VaultSecrets for DeviceSecrets {
    fn vault_key(&self) -> Result<Option<[u8; 32]>, String> {
        Ok(self.held_vault_key())
    }

    fn set_vault_key(&self, key: &[u8; 32]) -> Result<(), String> {
        self.written.lock().unwrap().push(hex(key));
        *self.vault_key.lock().unwrap() = Some(*key);
        Ok(())
    }

    fn delete_vault_key(&self) -> Result<(), String> {
        *self.vault_key.lock().unwrap() = None;
        Ok(())
    }

    fn session_token(&self) -> Result<Option<String>, String> {
        Ok(self.held_token())
    }

    fn set_session_token(&self, token: &str) -> Result<(), String> {
        self.written.lock().unwrap().push(token.to_owned());
        *self.token.lock().unwrap() = Some(token.to_owned());
        Ok(())
    }

    fn delete_session_token(&self) -> Result<(), String> {
        *self.token.lock().unwrap() = None;
        Ok(())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A device: a setup over its own secret store. Two of these against one
/// server are two devices on one account, which is the whole of the
/// "vault exists" shape.
fn device(base: &str, secrets: &Arc<DeviceSecrets>) -> Arc<HostedSetup> {
    let schedule = PollSchedule {
        first: Duration::from_millis(20),
        max: Duration::from_millis(60),
        give_up_after: Duration::from_secs(20),
    };
    Arc::new(
        HostedSetup::at(base)
            .expect("hosted setup")
            .with_schedules(schedule, schedule)
            .with_secrets(Arc::clone(secrets) as Arc<dyn VaultSecrets>),
    )
}

/// What reopening the app amounts to: a brand-new setup, holding nothing but
/// the same device's secret store. Every step it lands on is derived, because
/// there is nothing else left to derive it from.
fn reopened(base: &str, secrets: &Arc<DeviceSecrets>) -> Arc<HostedSetup> {
    device(base, secrets)
}

/// Signs a device in, the way a shell does, against its own secret store.
async fn device_signed_in(base: &str, secrets: &Arc<DeviceSecrets>) -> Arc<HostedSetup> {
    let setup = device(base, secrets);
    sign_in(&setup).await;
    setup
}

const VAULT_PASSWORD: &str = "a long enough vault password";

/// Stands in for the platform auth sheet: a browser-shaped client that follows
/// redirects and keeps cookies. The real server's login chain hands back an
/// `oidc_flow` cookie at the callback, so a client that drops it never signs in.
async fn browser_visit(url: &str) {
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .expect("browser-shaped client");
    let response = client.get(url).send().await.expect("open url in browser");
    assert!(
        response.status().is_success(),
        "browser fetch of {url} answered {}",
        response.status()
    );
}

/// Signs in the way a shell does: mint, open the URL, wait.
async fn signed_in(base: &str) -> Arc<HostedSetup> {
    let setup = setup(base);
    sign_in(&setup).await;
    setup
}

/// Mints a hand-off, waiting out a rate limit rather than failing on it.
///
/// A real server allows ten mints a minute per client and a whole run signs in
/// more devices than that, so this does what a shell does with the
/// `Retry-After` the engine hands back. The stub never rate limits, so a CI
/// run never waits.
async fn sign_in(setup: &HostedSetup) {
    let handoff = loop {
        match setup.begin_sign_in().await {
            Ok(handoff) => break handoff,
            Err(HostedError::RateLimited {
                retry_after_seconds,
            }) => {
                tokio::time::sleep(Duration::from_secs(u64::from(retry_after_seconds) + 1)).await;
            }
            Err(error) => panic!("begin sign in: {error}"),
        }
    };
    browser_visit(&handoff.url).await;
    match setup.await_sign_in(&handoff).await.expect("await sign in") {
        SignInOutcome::SignedIn(_) => {}
        other => panic!("expected a session, got {other:?}"),
    }
}

/// Delivers the lapse a real cancellation would, through the stand-in account
/// control both the stub and a stand-in server mount.
async fn lapse(setup: &HostedSetup) -> BillingStatus {
    let token = setup.session().expect("session").token;
    let response = reqwest::Client::new()
        .post(format!("{}/standin/lapse", setup.server_url()))
        .bearer_auth(token)
        .send()
        .await
        .expect("lapse the subscription");
    assert!(
        response.status().is_success(),
        "lapse: {}",
        response.status()
    );
    setup.billing_status().await.expect("billing status")
}

/// A real server keeps one account across scenarios, so a scenario that needs
/// an unsubscribed account says so rather than assuming it starts that way.
async fn unentitled(setup: &HostedSetup) -> BillingStatus {
    let status = setup.billing_status().await.expect("billing status");
    if status.entitled {
        lapse(setup).await
    } else {
        status
    }
}

/// One authenticated request outside the engine's own surface, for the
/// account controls a test needs and a shell never has.
async fn as_account(setup: &HostedSetup, method: reqwest::Method, path: &str) -> reqwest::Response {
    let token = setup.session().expect("session").token;
    reqwest::Client::new()
        .request(method.clone(), format!("{}{path}", setup.server_url()))
        .bearer_auth(token)
        .send()
        .await
        .unwrap_or_else(|error| panic!("{method} {path}: {error}"))
}

/// Puts the account back in the no-vault shape, whatever a previous scenario
/// left behind — a real stand-in server keeps one account across the whole
/// run. Deleting a vault is an entitled write, so this subscribes first.
async fn without_a_vault(setup: &HostedSetup) {
    entitled(setup).await;
    #[derive(serde::Deserialize)]
    struct Body {
        collection: Collection,
    }
    #[derive(serde::Deserialize)]
    struct Collection {
        id: String,
    }
    let claimed: Body = as_account(setup, reqwest::Method::POST, "/api/collections")
        .await
        .json()
        .await
        .expect("claim the collection");
    let deleted = as_account(
        setup,
        reqwest::Method::DELETE,
        &format!("/api/collections/{}", claimed.collection.id),
    )
    .await;
    assert!(
        deleted.status().is_success(),
        "deleting the vault: {}",
        deleted.status()
    );
}

/// Subscribes unless the account already may write. A real stand-in server
/// keeps one account across the whole run, so whether a scenario arrives
/// entitled depends on what ran before it.
async fn entitled(setup: &HostedSetup) {
    if !setup
        .billing_status()
        .await
        .expect("billing status")
        .entitled
    {
        subscribe(setup).await;
    }
}

/// Pays, and waits for the account to become entitled.
async fn subscribe(setup: &HostedSetup) {
    match setup.begin_checkout().await.expect("begin checkout") {
        Checkout::Open { url } => browser_visit(&url).await,
        Checkout::AlreadyEntitled(status) => panic!("expected a checkout URL, got {status:?}"),
    }
    match setup.await_entitled().await.expect("await entitled") {
        EntitlementOutcome::Entitled(status) => assert!(status.entitled),
        other => panic!("expected entitlement, got {other:?}"),
    }
}

/// The capability document, not the address, decides which sign-in to offer.
pub async fn the_probe_offers_hosted_sign_in(base: &str) {
    assert_eq!(
        probe_sign_in_flow(base).await.expect("probe"),
        SignInFlow::Hosted {
            sells_subscriptions: true
        }
    );
}

/// The whole of part one: log in, find the account cannot write yet, pay, and
/// watch the app notice on its own.
pub async fn sign_in_then_subscribe(base: &str) {
    let setup = setup(base);

    let handoff = setup.begin_sign_in().await.expect("begin sign in");
    assert!(
        handoff.url.contains(&handoff.ticket),
        "the hand-off URL carries its ticket: {}",
        handoff.url
    );
    browser_visit(&handoff.url).await;

    let session = match setup.await_sign_in(&handoff).await.expect("await sign in") {
        SignInOutcome::SignedIn(session) => session,
        other => panic!("expected a session, got {other:?}"),
    };
    assert!(!session.token.is_empty());
    assert!(session.email.contains('@'), "email: {}", session.email);
    assert_eq!(setup.session().as_ref(), Some(&session));

    let before = unentitled(&setup).await;
    assert!(!before.entitled);
    assert!(before.storage_quota_bytes > 0, "the plan carries a quota");

    subscribe(&setup).await;
    let after = setup.billing_status().await.expect("billing status");
    assert!(after.entitled);
    assert_ne!(after.state, "none", "an entitled account has a state");
}

/// Dismissing the sheet lands back on the sync screen with no error and no
/// half state — the wait ends, and no session is left behind.
pub async fn a_dismissed_sheet_cancels_the_wait(base: &str) {
    let setup = setup(base);
    let handoff = setup.begin_sign_in().await.expect("begin sign in");

    let waiting = tokio::spawn({
        let setup = Arc::clone(&setup);
        let handoff = handoff.clone();
        async move { setup.await_sign_in(&handoff).await }
    });
    // Let the wait get past its first poll, so the cancel interrupts a real
    // wait rather than being read before one started.
    tokio::time::sleep(Duration::from_millis(80)).await;
    setup.cancel_wait();

    assert_eq!(
        waiting.await.expect("join").expect("await sign in"),
        SignInOutcome::Cancelled
    );
    assert!(setup.session().is_none(), "a cancel leaves no half session");
}

/// A ticket is single-use. Waiting on one that is already spent is reported as
/// expiry, so the app offers a fresh sign-in instead of polling forever.
pub async fn a_spent_ticket_is_reported_as_expired(base: &str) {
    let first = setup(base);
    let handoff = first.begin_sign_in().await.expect("begin sign in");
    browser_visit(&handoff.url).await;
    assert!(matches!(
        first.await_sign_in(&handoff).await.expect("await sign in"),
        SignInOutcome::SignedIn(_)
    ));

    // The same ticket again: unknown, expired and redeemed are one answer.
    let second = setup(base);
    assert_eq!(
        second
            .await_sign_in(&handoff)
            .await
            .expect("await a spent ticket"),
        SignInOutcome::Expired
    );
}

/// An account that may already write is never sent to pay again — a second
/// checkout would open a second subscription.
pub async fn an_entitled_account_is_not_sent_to_pay_again(base: &str) {
    let setup = signed_in(base).await;
    unentitled(&setup).await;
    subscribe(&setup).await;

    match setup.begin_checkout().await.expect("second checkout") {
        Checkout::AlreadyEntitled(status) => assert!(status.entitled),
        Checkout::Open { url } => {
            panic!("an entitled account was offered a second checkout: {url}")
        }
    }
}

/// "Manage subscription" hands out a URL to open and nothing else: this app
/// writes no billing state, so cancelling, invoices, and cards all live behind
/// this one link (ADR 0003, decision 8). It is also what the "Vault is full"
/// banner's button opens, which is why an entitled account must get one too.
pub async fn the_account_card_can_open_the_billing_portal(base: &str) {
    let setup = signed_in(base).await;
    unentitled(&setup).await;
    subscribe(&setup).await;

    let portal = setup.billing_portal().await.expect("a portal URL");

    assert!(
        portal.starts_with("http"),
        "a portal URL a browser can open, got {portal}"
    );
}

/// A lapsed subscription is a fact the account card reads, not a failure. The
/// session still works and reads are never gated, so a lapsed card never
/// strands a device.
pub async fn a_lapsed_subscription_is_readable_and_not_a_sign_out(base: &str) {
    let setup = signed_in(base).await;
    unentitled(&setup).await;
    subscribe(&setup).await;

    let lapsed = lapse(&setup).await;

    assert!(!lapsed.entitled, "a lapsed account may not write");
    assert_ne!(lapsed.state, "active");
    assert!(
        setup.session().is_some(),
        "a lapsed subscription is not a sign-out"
    );
    assert!(!setup.billing_status().await.expect("read again").entitled);
}

// ── The no-vault shape: subscribe, create a vault, save the recovery key ──

/// The whole of the first wizard shape. Every step the person lands on is
/// computed from what the server says, and the recovery key comes back once.
pub async fn a_fresh_account_creates_a_vault(base: &str) {
    let secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    unentitled(&phone).await;

    assert_eq!(
        phone.current_step().await.expect("step"),
        SetupStep::Subscribe,
        "an account with no vault cannot skip subscribing: writing the vault key is gated"
    );
    subscribe(&phone).await;
    assert_eq!(
        phone.current_step().await.expect("step"),
        SetupStep::CreateVault
    );

    let recovery_key = phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");

    // Seven groups of four, which is what the save screen shows (ADR 0003,
    // decision 6).
    let groups: Vec<&str> = recovery_key.split('-').collect();
    assert_eq!(groups.len(), 7, "recovery key: {recovery_key}");
    assert!(groups.iter().all(|group| group.len() == 4));

    assert_eq!(phone.current_step().await.expect("step"), SetupStep::Ready);
    assert!(
        secrets.held_vault_key().is_some(),
        "the device kept the key"
    );
    assert!(secrets.held_token().is_some(), "the device kept the token");

    // The vault password is typed once and forgotten. Nothing this device
    // wrote to its secret store is it.
    assert!(
        !secrets
            .everything_written()
            .iter()
            .any(|written| written.contains(VAULT_PASSWORD)),
        "the vault password reached the secret store"
    );
}

/// The recovery key is handed over once and there is no second way to ask for
/// it: creating again is refused, because a second vault key would orphan
/// every note already encrypted under the first.
pub async fn the_recovery_key_cannot_be_asked_for_twice(base: &str) {
    let secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;
    phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");

    assert_eq!(
        phone.create_vault(VAULT_PASSWORD).await.unwrap_err(),
        HostedError::VaultAlreadyExists
    );
    // Not even from a fresh setup that has forgotten this attempt entirely.
    assert_eq!(
        reopened(base, &secrets)
            .create_vault(VAULT_PASSWORD)
            .await
            .unwrap_err(),
        HostedError::VaultAlreadyExists
    );
}

/// Writing the vault key is entitlement-gated, so an account that has not paid
/// is told that in as many words rather than meeting a bare `402` later.
pub async fn creating_a_vault_without_a_subscription_is_refused(base: &str) {
    let secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    unentitled(&phone).await;

    assert_eq!(
        phone.create_vault(VAULT_PASSWORD).await.unwrap_err(),
        HostedError::NotEntitled
    );
    assert!(
        secrets.held_vault_key().is_none(),
        "a refused create kept a key for a vault that does not exist"
    );
    assert_eq!(
        phone.current_step().await.expect("step"),
        SetupStep::Subscribe
    );
}

/// The length rule lives in the engine, so three shells cannot each pick their
/// own — and nothing is sent for a password that would be refused.
pub async fn a_short_vault_password_is_refused_before_anything_is_written(base: &str) {
    let secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;

    assert_eq!(
        phone.create_vault("short").await.unwrap_err(),
        HostedError::VaultPasswordTooShort { minimum: 12 }
    );
    assert_eq!(
        phone.current_step().await.expect("step"),
        SetupStep::CreateVault,
        "a refused password left the wizard where it was"
    );
}

// ── The vault-exists shape: a second device unlocks ──

/// A second device on the same account is offered the unlock step, and the
/// vault password opens it. A wrong one is its own answer, and leaves the
/// device exactly where it was.
pub async fn a_second_device_unlocks_with_the_vault_password(base: &str) {
    let (first_secrets, laptop, secrets) = a_vault_and_a_new_device(base).await;

    assert_eq!(
        laptop.current_step().await.expect("step"),
        SetupStep::Unlock
    );
    assert_eq!(
        laptop
            .unlock_with_vault_password("not the vault password")
            .await
            .unwrap_err(),
        HostedError::WrongVaultPassword
    );
    assert_eq!(
        laptop.current_step().await.expect("step"),
        SetupStep::Unlock,
        "a wrong password is not a half-unlocked device"
    );

    laptop
        .unlock_with_vault_password(VAULT_PASSWORD)
        .await
        .expect("unlock");

    assert_eq!(laptop.current_step().await.expect("step"), SetupStep::Ready);
    assert_eq!(
        secrets.held_vault_key(),
        first_secrets.held_vault_key(),
        "both devices hold the same vault key, or they cannot read each other's notes"
    );
}

/// The third door. A device that has lost the vault password gets in with the
/// recovery key, and ends up indistinguishable from one that typed the
/// password.
pub async fn a_second_device_unlocks_with_the_recovery_key(base: &str) {
    let first_secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &first_secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;
    let recovery_key = phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");

    let secrets = DeviceSecrets::new();
    let laptop = device_signed_in(base, &secrets).await;
    assert_eq!(
        laptop.current_step().await.expect("step"),
        SetupStep::Unlock
    );

    // A real recovery key — check character and all — for some other vault.
    let someone_elses = another_recovery_key(&recovery_key);
    assert_eq!(
        laptop
            .unlock_with_recovery_key(&someone_elses)
            .await
            .unwrap_err(),
        HostedError::WrongRecoveryKey
    );

    laptop
        .unlock_with_recovery_key(&recovery_key)
        .await
        .expect("unlock with the recovery key");

    assert_eq!(laptop.current_step().await.expect("step"), SetupStep::Ready);
    assert_eq!(secrets.held_vault_key(), first_secrets.held_vault_key());
}

// ── Where the wizard resumes, and signing out ──

/// The criterion that kills a stored wizard position: quit at each step,
/// reopen with nothing but the secret store, and land on the step the server's
/// own facts imply.
pub async fn quitting_mid_wizard_resumes_at_the_right_step(base: &str) {
    // Quit right after signing in.
    let secrets = DeviceSecrets::new();
    let signing_in = device_signed_in(base, &secrets).await;
    without_a_vault(&signing_in).await;
    unentitled(&signing_in).await;
    drop(signing_in);

    assert_eq!(
        reopened(base, &secrets).current_step().await.expect("step"),
        SetupStep::Subscribe,
        "a signed-in device with no vault and no subscription"
    );

    // Quit right after paying.
    let paying = reopened(base, &secrets);
    subscribe(&paying).await;
    drop(paying);
    assert_eq!(
        reopened(base, &secrets).current_step().await.expect("step"),
        SetupStep::CreateVault,
        "entitled, still no vault"
    );

    // Quit right after creating the vault: it is the device holding the key
    // that decides, and this one does.
    let creating = reopened(base, &secrets);
    creating
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");
    drop(creating);
    assert_eq!(
        reopened(base, &secrets).current_step().await.expect("step"),
        SetupStep::Ready,
        "a cold start on a set-up device asks for nothing"
    );

    // The same account seen by a device that never unlocked.
    secrets.forget_vault_key();
    assert_eq!(
        reopened(base, &secrets).current_step().await.expect("step"),
        SetupStep::Unlock,
        "the vault exists but this device does not hold its key"
    );
}

/// Sign out is one action: the session is revoked, both secrets are gone, and
/// this vault's live sync state is demoted exactly as disconnect does — no
/// locked-but-signed-in state left behind (ADR 0003, decision 9).
pub async fn signing_out_forgets_the_key_the_token_and_the_live_state(base: &str) {
    let secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;
    phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");

    let root = live_vault();
    let sync = SyncSession::new();

    phone.sign_out(&sync, &root).await.expect("sign out");

    assert_eq!(secrets.held_vault_key(), None, "the vault key was kept");
    assert_eq!(secrets.held_token(), None, "the session token was kept");
    assert!(
        !root.join(".e2ee-state.json").exists(),
        "live sync state survived a sign out"
    );
    // Demoted, not merely deleted: what was already pushed survives as
    // ancestry, so a later sign-in reconciles against it instead of reading
    // local absence as a fleet-wide delete.
    let ancestry = std::fs::read_to_string(root.join(".e2ee-ancestry.json"))
        .expect("sign out left no ancestry behind");
    assert!(
        ancestry.contains("grocery list.md") && ancestry.contains("hash-of-the-list"),
        "ancestry lost what this vault had already pushed: {ancestry}"
    );
    assert_eq!(
        reopened(base, &secrets).current_step().await.expect("step"),
        SetupStep::SignIn,
        "a signed-out device starts at the beginning"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// A vault mid-sync: one note already pushed, and the live checkpoint that
/// says so. Written as the file the engine reads rather than through
/// `ConnectedState`, which a test outside the crate cannot serialize — the
/// shape is `checkpoint::DiskState`.
fn live_vault() -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "futo-hosted-signout-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).expect("create the vault root");
    std::fs::write(
        root.join(".e2ee-state.json"),
        r#"{
  "version": 1,
  "object_map": {
    "grocery list.md": {
      "objectId": "object-1",
      "version": 4,
      "blobKey": "blob-1",
      "hash": "hash-of-the-list"
    }
  },
  "max_version": 9,
  "pull_cursor": 9,
  "collection_id": "collection-1"
}"#,
    )
    .expect("write the live checkpoint");
    root
}

/// A vault created by one device, and a second device signed in to the same
/// account holding nothing.
async fn a_vault_and_a_new_device(
    base: &str,
) -> (Arc<DeviceSecrets>, Arc<HostedSetup>, Arc<DeviceSecrets>) {
    let first_secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &first_secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;
    phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");

    let secrets = DeviceSecrets::new();
    let laptop = device_signed_in(base, &secrets).await;
    (first_secrets, laptop, secrets)
}

/// A different, well-formed recovery key: the same one with its first data
/// character rotated, re-checksummed by asking the engine to format it.
fn another_recovery_key(formatted: &str) -> String {
    use futo_notes_core::e2ee::RecoveryKey;
    let mut bytes = *RecoveryKey::parse(formatted)
        .expect("the engine's own recovery key parses")
        .as_bytes();
    bytes[0] ^= 0xFF;
    RecoveryKey::from_bytes(bytes).to_string()
}

// ── QR pairing: the new device shows, the unlocked device scans ──
//
// Two devices and a relay between them, which is the whole point of pairing.
// The camera is stood in for by passing the payload as a string, exactly as
// ADR 0003's testing decision says.

/// The whole flow. A second device that knows no password and no recovery key
/// ends up holding the same vault key as the first, and neither the vault key
/// nor the pairing keypair's private half is ever handed to a caller.
pub async fn pairing_hands_the_vault_key_to_a_new_device(base: &str) {
    let (unlocked_secrets, unlocked, laptop_secrets, laptop) =
        a_vault_and_a_device_to_pair(base).await;

    // The new device draws a code.
    let code = laptop
        .begin_pairing("Kitchen laptop")
        .await
        .expect("begin pairing");
    assert!(!code.expires_at.is_empty(), "the code says when it dies");

    // …and starts polling before anyone scans it.
    let waiting = tokio::spawn({
        let laptop = Arc::clone(&laptop);
        async move { laptop.await_pairing().await }
    });

    // The unlocked device scans, and is told what to put on the confirm sheet.
    let scanned = unlocked
        .complete_pairing(&code.payload)
        .expect("read the scanned code");
    assert_eq!(scanned.device_name(), "Kitchen laptop");
    assert!(
        ["ios", "android", "desktop"].contains(&scanned.platform()),
        "platform: {}",
        scanned.platform()
    );

    // The person confirms.
    unlocked.confirm_pairing(&scanned).await.expect("confirm");

    assert_eq!(
        waiting.await.expect("join").expect("await pairing"),
        PairingOutcome::Paired
    );
    assert_eq!(
        laptop.current_step().await.expect("step"),
        SetupStep::Ready,
        "a paired device is asked for nothing"
    );
    assert_eq!(
        laptop_secrets.held_vault_key(),
        unlocked_secrets.held_vault_key(),
        "both devices hold the same vault key, or they cannot read each other's notes"
    );
    assert!(
        laptop_secrets.held_token().is_some(),
        "a paired device kept its session too"
    );
    // Neither the vault password nor the pairing code ever reached this
    // device's secret store: the only things in it are the key and the token.
    assert!(
        !laptop_secrets
            .everything_written()
            .iter()
            .any(|written| written.contains(VAULT_PASSWORD) || written.contains(&code.payload)),
        "a paired device kept something it should not have"
    );
    // Spent. The relay deleted the pairing when it served the key.
    assert_eq!(
        laptop.await_pairing().await.unwrap_err(),
        HostedError::PairingNotStarted
    );
}

/// A scan is a parse and nothing else. Reading a code touches no network, so a
/// wrong scan — or a right one the person then declines — sends nothing
/// (parent spec user story 16).
pub async fn a_scanned_code_sends_nothing_until_the_person_confirms(base: &str) {
    let (_, unlocked, _, laptop) = a_vault_and_a_device_to_pair(base).await;
    let code = laptop
        .begin_pairing("Kitchen laptop")
        .await
        .expect("begin pairing");

    let scanned = unlocked.complete_pairing(&code.payload).expect("read");
    assert_eq!(scanned.device_name(), "Kitchen laptop");

    // Straight at the relay: the new device's pairing is still waiting.
    let pairing_id = pairing_id_of(&code.payload);
    let polled = as_account(
        &laptop,
        reqwest::Method::GET,
        &format!("/api/pairings/{pairing_id}"),
    )
    .await;
    assert_eq!(
        polled.status().as_u16(),
        202,
        "parsing a scanned code posted a vault key"
    );

    // And only now, on confirm, does anything go out.
    unlocked.confirm_pairing(&scanned).await.expect("confirm");
    assert_eq!(
        laptop.await_pairing().await.expect("await pairing"),
        PairingOutcome::Paired
    );
}

/// A camera points at whatever is in front of it. None of this is a pairing
/// code, and none of it reaches the network — the unlocked device stays
/// unlocked and no key is sealed to anything.
pub async fn a_scan_that_is_not_a_pairing_code_sends_nothing(base: &str) {
    let (_, unlocked, _, _) = a_vault_and_a_device_to_pair(base).await;

    for scanned in [
        "",
        "https://futo.org",
        "WIFI:S:cafe;T:WPA;P:hunter2;;",
        r#"{"futo_notes_pairing":1,"id":"x"}"#,
        r#"{"futo_notes_pairing":99,"id":"x","public_key":"AAAA","device_name":"n","platform":"ios"}"#,
    ] {
        assert_eq!(
            unlocked.complete_pairing(scanned).unwrap_err(),
            HostedError::PairingCodeInvalid,
            "scanned: {scanned:?}"
        );
    }
}

/// A pairing this account cannot reach is one answer, whatever the reason.
/// Unknown, expired, already collected and another account's are the same
/// `404` on the wire (server ADR 0008), so the client says the one true thing:
/// show a new code.
pub async fn a_pairing_this_account_cannot_reach_is_refused(base: &str) {
    let (_, unlocked, _, laptop) = a_vault_and_a_device_to_pair(base).await;

    // A code this engine wrote, pointed at a pairing the relay never minted.
    let real = laptop
        .begin_pairing("Kitchen laptop")
        .await
        .expect("begin pairing");
    let stranger = with_pairing_id(&real.payload, "koiKEC2jss5UMppDtKLHp5Zal8NhdQG2_plXmsHL0BI");
    let scanned = unlocked.complete_pairing(&stranger).expect("a valid code");
    assert_eq!(
        unlocked.confirm_pairing(&scanned).await.unwrap_err(),
        HostedError::PairingRefused,
    );
    assert!(
        laptop.current_step().await.expect("step") != SetupStep::Ready,
        "a refused pairing unlocked something"
    );
}

/// One key per pairing. A second post is refused as a conflict rather than
/// silently accepted, and it is not retryable: a sealed box is
/// nondeterministic, so a repeat carries different bytes and the server has
/// nothing to match them against.
pub async fn a_pairing_can_only_be_answered_once(base: &str) {
    let (_, unlocked, _, laptop) = a_vault_and_a_device_to_pair(base).await;
    let code = laptop
        .begin_pairing("Kitchen laptop")
        .await
        .expect("begin pairing");
    let scanned = unlocked.complete_pairing(&code.payload).expect("read");

    unlocked.confirm_pairing(&scanned).await.expect("confirm");
    assert_eq!(
        unlocked.confirm_pairing(&scanned).await.unwrap_err(),
        HostedError::PairingAlreadyKeyed,
    );
}

/// Collecting spends the pairing. The key is served exactly once, so a device
/// that collects it and asks again is refused rather than handed a replay —
/// and an uncollected vault key never sits on the server after that.
pub async fn collecting_the_key_spends_the_pairing(base: &str) {
    let (_, unlocked, _, laptop) = a_vault_and_a_device_to_pair(base).await;
    let code = laptop
        .begin_pairing("Kitchen laptop")
        .await
        .expect("begin pairing");
    let scanned = unlocked.complete_pairing(&code.payload).expect("read");
    unlocked.confirm_pairing(&scanned).await.expect("confirm");
    assert_eq!(
        laptop.await_pairing().await.expect("await pairing"),
        PairingOutcome::Paired
    );

    let pairing_id = pairing_id_of(&code.payload);
    let again = as_account(
        &laptop,
        reqwest::Method::GET,
        &format!("/api/pairings/{pairing_id}"),
    )
    .await;
    assert_eq!(
        again.status().as_u16(),
        404,
        "a collected pairing was served a second time"
    );
}

/// Leaving the pairing screen ends the wait with no error and no half state.
/// The code is still live until it expires; showing it again means a new one.
pub async fn leaving_the_pairing_screen_cancels_the_wait(base: &str) {
    let (_, _, secrets, laptop) = a_vault_and_a_device_to_pair(base).await;
    laptop
        .begin_pairing("Kitchen laptop")
        .await
        .expect("begin pairing");

    let waiting = tokio::spawn({
        let laptop = Arc::clone(&laptop);
        async move { laptop.await_pairing().await }
    });
    tokio::time::sleep(Duration::from_millis(80)).await;
    laptop.cancel_wait();

    assert_eq!(
        waiting.await.expect("join").expect("await pairing"),
        PairingOutcome::Cancelled
    );
    assert_eq!(
        secrets.held_vault_key(),
        None,
        "a cancel unlocked the vault"
    );
}

// ── Stub-only pairing scenarios ──
//
// A stand-in server has one identity and a fixed five-minute window, so these
// two cannot run against one. They are registered in `tests/hosted_setup.rs`
// alone; `tests/server_integration.rs` says so where the list is. This file is
// compiled into both binaries, so they and their helpers are dead code in the
// one that does not call them — allowed here rather than silenced file-wide,
// so a scenario nobody registered anywhere still shows up.

/// The window closes and the code stops being a code. A person who declines on
/// the other device sends nothing, so declining and walking away both land
/// here — which is why this is expiry and not a refusal.
#[allow(
    dead_code,
    reason = "registered by the stub runner alone; see the section note"
)]
pub async fn an_expired_pairing_code_is_its_own_error(base: &str) {
    let (_, _, secrets, laptop) = a_vault_and_a_device_to_pair(base).await;
    let response = as_account_with_body(
        &laptop,
        reqwest::Method::POST,
        "/standin/pairing-window",
        serde_json::json!({ "seconds": 2 }),
    )
    .await;
    assert!(response.status().is_success(), "shorten the pairing window");

    laptop
        .begin_pairing("Kitchen laptop")
        .await
        .expect("begin pairing");

    assert_eq!(
        laptop.await_pairing().await.unwrap_err(),
        HostedError::PairingExpired,
    );
    assert_eq!(secrets.held_vault_key(), None);
}

/// Another account's live, unexpired, uncollected pairing is refused exactly
/// as an unknown one is — which is what stops a pairing id being probed for
/// existence from another account.
#[allow(
    dead_code,
    reason = "registered by the stub runner alone; see the section note"
)]
pub async fn another_accounts_live_pairing_is_refused(base: &str) {
    let (_, unlocked, _, _) = a_vault_and_a_device_to_pair(base).await;

    // A device on a different account, shown its own code.
    let stranger_secrets = DeviceSecrets::new();
    stranger_secrets
        .set_session_token(&second_identity(base).await)
        .expect("seed the stranger's session");
    let stranger = device(base, &stranger_secrets);
    let code = stranger
        .begin_pairing("Somebody else's phone")
        .await
        .expect("begin pairing");

    let scanned = unlocked
        .complete_pairing(&code.payload)
        .expect("a well-formed code");
    assert_eq!(scanned.device_name(), "Somebody else's phone");
    assert_eq!(
        unlocked.confirm_pairing(&scanned).await.unwrap_err(),
        HostedError::PairingRefused,
        "a vault key was posted to another account's pairing"
    );

    // And the stranger's own pairing is untouched: still waiting, not keyed.
    let pairing_id = pairing_id_of(&code.payload);
    let polled = as_account(
        &stranger,
        reqwest::Method::GET,
        &format!("/api/pairings/{pairing_id}"),
    )
    .await;
    assert_eq!(polled.status().as_u16(), 202);
}

/// A vault created on one device, plus a second device signed in to the same
/// account holding nothing — the two sides of every pairing scenario.
async fn a_vault_and_a_device_to_pair(
    base: &str,
) -> (
    Arc<DeviceSecrets>,
    Arc<HostedSetup>,
    Arc<DeviceSecrets>,
    Arc<HostedSetup>,
) {
    let (unlocked_secrets, laptop, laptop_secrets) = a_vault_and_a_new_device(base).await;
    let unlocked = device(base, &unlocked_secrets);
    (unlocked_secrets, unlocked, laptop_secrets, laptop)
}

/// A code the engine wrote, pointed at a different pairing id. Built by
/// rewriting one field of a real payload rather than by spelling the format
/// out again, so a test cannot drift from what `complete_pairing` reads.
fn with_pairing_id(payload: &str, id: &str) -> String {
    let mut value: serde_json::Value =
        serde_json::from_str(payload).expect("a payload this engine wrote");
    value["id"] = serde_json::Value::String(id.to_owned());
    value.to_string()
}

/// The pairing id a payload carries, for the handful of assertions that go
/// straight at the relay rather than through the engine.
fn pairing_id_of(payload: &str) -> String {
    serde_json::from_str::<serde_json::Value>(payload)
        .expect("a payload this engine wrote")
        .get("id")
        .and_then(serde_json::Value::as_str)
        .expect("a payload carries its pairing id")
        .to_owned()
}

/// A session token for a second account. Stub-only: a real stand-in server
/// signs everybody in as one identity.
#[allow(
    dead_code,
    reason = "registered by the stub runner alone; see the section note"
)]
async fn second_identity(base: &str) -> String {
    let response = reqwest::Client::new()
        .post(format!("{base}/standin/second-identity"))
        .send()
        .await
        .expect("mint a second identity");
    assert!(response.status().is_success());
    response
        .json::<serde_json::Value>()
        .await
        .expect("json")
        .get("token")
        .and_then(serde_json::Value::as_str)
        .expect("a token")
        .to_owned()
}

/// [`as_account`] with a body.
#[allow(
    dead_code,
    reason = "registered by the stub runner alone; see the section note"
)]
async fn as_account_with_body(
    setup: &HostedSetup,
    method: reqwest::Method,
    path: &str,
    body: serde_json::Value,
) -> reqwest::Response {
    let token = setup.session().expect("session").token;
    reqwest::Client::new()
        .request(method.clone(), format!("{}{path}", setup.server_url()))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .unwrap_or_else(|error| panic!("{method} {path}: {error}"))
}

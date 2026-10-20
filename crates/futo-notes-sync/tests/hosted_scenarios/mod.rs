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
    PairingOutcome, PollSchedule, SetupStep, SignInFlow, SignInHandoff, SignInOutcome, SyncSession,
    VaultSecrets,
};

mod pairing;
mod sign_in;
mod vault_doors;
mod vault_password;
mod wizard_lifecycle;

pub use pairing::*;
pub use sign_in::*;
pub use vault_doors::*;
pub use vault_password::*;
pub use wizard_lifecycle::*;

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
///
/// `sync_password` is the OTHER credential a real device's store can hold —
/// the self-hosted sync password — which no hosted step writes and one clears.
#[derive(Default)]
pub struct DeviceSecrets {
    vault_key: Mutex<Option<[u8; 32]>>,
    token: Mutex<Option<String>>,
    sync_password: Mutex<Option<String>>,
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

    /// A device that has connected to someone's own server before, and so is
    /// still holding the sync password that reconnects to it.
    fn hold_sync_password(&self, password: &str) {
        *self.sync_password.lock().unwrap() = Some(password.to_owned());
    }

    fn held_sync_password(&self) -> Option<String> {
        self.sync_password.lock().unwrap().clone()
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

    fn delete_sync_password(&self) -> Result<(), String> {
        *self.sync_password.lock().unwrap() = None;
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
/// What a change of vault password sets, and what a second change sets after
/// that. Distinct so a scenario can say which of the three the vault takes.
const NEW_VAULT_PASSWORD: &str = "the second vault password";
const THIRD_VAULT_PASSWORD: &str = "the third vault password";

/// The OTHER credential — what a device that once connected to someone's own
/// server is still holding. Nothing hosted ever writes it; one hosted step
/// clears it.
const A_SELF_HOSTED_PASSWORD: &str = "the password for my own server";

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
///
/// EVERY mint in this file goes through here. It used to live inside `sign_in`
/// alone, and the three scenarios that mint a hand-off directly — because the
/// hand-off itself is what they assert on — failed against a real server with
/// `RateLimited { retry_after_seconds: 59 }` as soon as a run crossed ten
/// sign-ins in a minute.
async fn mint_handoff(setup: &HostedSetup) -> SignInHandoff {
    loop {
        match setup.begin_sign_in().await {
            Ok(handoff) => return handoff,
            Err(HostedError::RateLimited {
                retry_after_seconds,
            }) => {
                tokio::time::sleep(Duration::from_secs(u64::from(retry_after_seconds) + 1)).await;
            }
            Err(error) => panic!("begin sign in: {error}"),
        }
    }
}

/// The three steps behind every sign-in above: mint, open the URL in a
/// browser-shaped client, wait for the session.
async fn sign_in(setup: &HostedSetup) {
    let handoff = mint_handoff(setup).await;
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

/// An empty vault root, the way a device that has never synced starts.
fn fresh_vault() -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "futo-hosted-connect-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).expect("create the vault root");
    root
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

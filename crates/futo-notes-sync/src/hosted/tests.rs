//! Tests that need to see inside the crate. The hosted flow's own scenarios
//! live in `tests/hosted_setup.rs`, which drives the public surface against a
//! stub of the server's hosted routes.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::*;
use crate::checkpoint::{self, ConnectedState, ObjectState};

fn temp_root() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "futo-hosted-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).expect("create temp root");
    root
}

/// A vault mid-sync: one object in the map, a cursor, a max version.
fn live_vault(root: &std::path::Path) {
    let mut state = ConnectedState::new(
        "https://notes-sync.futo.org".into(),
        "token".into(),
        "user".into(),
        "collection".into(),
        [7u8; 32],
    );
    state.object_map.insert(
        "grocery list.md".into(),
        ObjectState {
            object_id: "object".into(),
            version: 4,
            blob_key: "blob".into(),
            hash: Some("hash".into()),
            mtime_ms: None,
            size_bytes: None,
        },
    );
    state.max_version = 9;
    state.pull_cursor = 9;
    checkpoint::save(root, &state).expect("save checkpoint");
}

async fn server_answering_invalid_session() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/billing"))
        .respond_with(ResponseTemplate::new(401).set_body_raw(
            r#"{"code":"invalid_session","error":"session expired or invalid"}"#,
            "application/json",
        ))
        .mount(&server)
        .await;
    server
}

fn signed_in(setup: &HostedSetup) {
    *setup.session.lock().unwrap() = Some(HostedSession {
        user_id: "user".into(),
        email: "person@standin.test".into(),
        name: "Stand-in Person".into(),
        token: "dead".into(),
    });
}

/// An expired hosted session is a trip to the browser, not a vault reset.
/// The distinction matters because password mode's 401 means something else
/// entirely — there the client re-logs-in from the saved password — and the
/// wrong reading here would strand a person in a re-setup wizard.
#[tokio::test]
async fn an_expired_hosted_session_is_reported_as_sign_in_again() {
    let server = server_answering_invalid_session().await;
    let setup = HostedSetup::at(&server.uri()).unwrap();
    signed_in(&setup);

    assert_eq!(
        setup.billing_status().await.unwrap_err(),
        HostedError::SignInAgain
    );
}

/// The regression this pins: handling that 401 must leave the vault's live
/// sync state exactly where it was. A demotion here would throw away the
/// object map and the cursor, and the next connect would be a full bootstrap
/// pull that re-reconciles every note — the shape of failure that produced
/// conflict-copy spam before.
#[tokio::test]
async fn sign_in_again_leaves_every_byte_of_sync_state_alone() {
    let root = temp_root();
    live_vault(&root);
    let before = std::fs::read_to_string(checkpoint::state_path(&root)).unwrap();

    let server = server_answering_invalid_session().await;
    let setup = HostedSetup::at(&server.uri()).unwrap();
    signed_in(&setup);
    let error = setup.billing_status().await.unwrap_err();

    assert_eq!(error, HostedError::SignInAgain);
    assert_eq!(
        std::fs::read_to_string(checkpoint::state_path(&root)).unwrap(),
        before,
        "the live sync checkpoint changed"
    );
    let loaded = checkpoint::load(&root, "collection");
    assert_eq!(loaded.max_version, 9);
    assert_eq!(loaded.pull_cursor, 9);
    assert!(loaded.object_map.contains_key("grocery list.md"));
    assert!(
        !root.join(".e2ee-ancestry.json").exists(),
        "sync state was demoted to ancestry"
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// The steps that need a session say so, rather than sending an unauthorised
/// request and reporting whatever the server says about it.
#[tokio::test]
async fn billing_and_checkout_refuse_before_sign_in() {
    let setup = HostedSetup::at("https://notes-sync.futo.org").unwrap();

    assert_eq!(
        setup.billing_status().await.unwrap_err(),
        HostedError::NotSignedIn
    );
    assert_eq!(
        setup.begin_checkout().await.unwrap_err(),
        HostedError::NotSignedIn
    );
    assert!(setup.session().is_none());
}

/// A self-hosted server has no billing route at all, and a 404 there is a
/// different thing to say than "your session died".
#[tokio::test]
async fn a_server_without_the_hosted_routes_says_so() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/billing"))
        .respond_with(
            ResponseTemplate::new(404).set_body_raw(r#"{"error":"not found"}"#, "application/json"),
        )
        .mount(&server)
        .await;
    let setup = HostedSetup::at(&server.uri()).unwrap();
    signed_in(&setup);

    assert_eq!(
        setup.billing_status().await.unwrap_err(),
        HostedError::NotHosted("not found".into())
    );
}

/// Minting is rate limited; the server's own `Retry-After` reaches the caller
/// so a shell can wait that long instead of hammering.
#[tokio::test]
async fn a_rate_limited_mint_carries_the_servers_retry_after() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/auth/handoff"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "42")
                .set_body_raw(r#"{"error":"too many requests"}"#, "application/json"),
        )
        .mount(&server)
        .await;
    let setup = HostedSetup::at(&server.uri()).unwrap();

    assert_eq!(
        setup.begin_sign_in().await.unwrap_err(),
        HostedError::RateLimited {
            retry_after_seconds: 42
        }
    );
}

/// The setup normalises its address the same way the engine does, so a
/// trailing slash cannot produce `//api/billing`.
#[test]
fn the_server_address_is_normalised() {
    let setup = HostedSetup::at("  https://notes-sync.futo.org/  ").unwrap();
    assert_eq!(setup.server_url(), "https://notes-sync.futo.org");
}

// ── The vault doors ────────────────────────────────────────────────────────

/// One device's secret store, in memory.
#[derive(Default)]
struct TestSecrets {
    vault_key: std::sync::Mutex<Option<[u8; 32]>>,
    token: std::sync::Mutex<Option<String>>,
    /// The self-hosted sync password, which no hosted step writes and
    /// `connect_sync` clears.
    sync_password: std::sync::Mutex<Option<String>>,
}

impl TestSecrets {
    fn holding(token: &str, vault_key: [u8; 32]) -> Arc<Self> {
        Arc::new(Self {
            vault_key: std::sync::Mutex::new(Some(vault_key)),
            token: std::sync::Mutex::new(Some(token.to_owned())),
            ..Default::default()
        })
    }
}

impl VaultSecrets for TestSecrets {
    fn vault_key(&self) -> Result<Option<[u8; 32]>, String> {
        Ok(*self.vault_key.lock().unwrap())
    }
    fn set_vault_key(&self, key: &[u8; 32]) -> Result<(), String> {
        *self.vault_key.lock().unwrap() = Some(*key);
        Ok(())
    }
    fn delete_vault_key(&self) -> Result<(), String> {
        *self.vault_key.lock().unwrap() = None;
        Ok(())
    }
    fn session_token(&self) -> Result<Option<String>, String> {
        Ok(self.token.lock().unwrap().clone())
    }
    fn set_session_token(&self, token: &str) -> Result<(), String> {
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

/// A typo is caught by the check character before anything is sent. The proof
/// is that this setup points at a port nothing listens on and holds no session
/// at all: a recovery key that reached either would answer `Network` or
/// `NotSignedIn` instead (parent spec user story 18).
#[tokio::test]
async fn a_mistyped_recovery_key_never_reaches_the_network() {
    let setup = HostedSetup::at("http://127.0.0.1:9")
        .unwrap()
        .with_secrets(Arc::new(TestSecrets::default()) as Arc<dyn VaultSecrets>);

    // A real recovery key with one data character changed and the check
    // character left alone — exactly what a typo looks like.
    let key = futo_notes_core::e2ee::RecoveryKey::from_bytes([0x11; 16]).to_string();
    let mut typed: Vec<char> = key.chars().collect();
    let first = typed.iter().position(char::is_ascii_alphanumeric).unwrap();
    typed[first] = if typed[first] == '2' { '3' } else { '2' };
    let typo: String = typed.into_iter().collect();

    assert_eq!(
        setup.unlock_with_recovery_key(&typo).await.unwrap_err(),
        HostedError::RecoveryKeyTypo
    );
    assert_eq!(
        setup
            .unlock_with_recovery_key("not a recovery key")
            .await
            .unwrap_err(),
        HostedError::RecoveryKeyFormat
    );
}

/// A saved token the server no longer accepts sends the person back to the
/// browser — and takes nothing else with it. The vault key stays exactly where
/// it is, because an expired session is not a vault reset (ADR 0003).
#[tokio::test]
async fn an_expired_saved_token_is_dropped_and_the_vault_key_is_not() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/auth"))
        .respond_with(ResponseTemplate::new(401).set_body_raw(
            r#"{"code":"invalid_session","error":"session expired or invalid"}"#,
            "application/json",
        ))
        .mount(&server)
        .await;
    let secrets = TestSecrets::holding("stale", [3u8; 32]);
    let setup = HostedSetup::at(&server.uri())
        .unwrap()
        .with_secrets(Arc::clone(&secrets) as Arc<dyn VaultSecrets>);

    assert_eq!(setup.current_step().await.unwrap(), SetupStep::SignIn);
    assert_eq!(
        secrets.session_token().unwrap(),
        None,
        "a token the server rejected is retried on every start"
    );
    assert_eq!(
        secrets.vault_key().unwrap(),
        Some([3u8; 32]),
        "an expired session took the vault key with it"
    );
}

/// Signing out demotes this vault's sync state by the same route disconnect
/// does — the live checkpoint is gone and verified ancestry is left behind, so
/// a later sign-in reconciles against what was actually pushed rather than
/// re-uploading a whole vault.
#[tokio::test]
async fn signing_out_demotes_sync_state_exactly_as_disconnect_does() {
    let signed_out = temp_root();
    let disconnected = temp_root();
    live_vault(&signed_out);
    live_vault(&disconnected);

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/auth/logout"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;
    let secrets = TestSecrets::holding("live", [9u8; 32]);
    let setup = HostedSetup::at(&server.uri())
        .unwrap()
        .with_secrets(Arc::clone(&secrets) as Arc<dyn VaultSecrets>);
    signed_in(&setup);

    setup
        .sign_out(&crate::SyncSession::new(), &signed_out)
        .await
        .expect("sign out");
    crate::SyncSession::new()
        .disconnect(&disconnected)
        .await
        .expect("disconnect");

    assert!(!checkpoint::state_path(&signed_out).exists());
    assert_eq!(
        std::fs::read_to_string(signed_out.join(".e2ee-ancestry.json")).ok(),
        std::fs::read_to_string(disconnected.join(".e2ee-ancestry.json")).ok(),
        "sign out and disconnect left different sync state behind"
    );
    assert_eq!(secrets.vault_key().unwrap(), None);
    assert_eq!(secrets.session_token().unwrap(), None);

    let _ = std::fs::remove_dir_all(&signed_out);
    let _ = std::fs::remove_dir_all(&disconnected);
}

/// The server call is best-effort: a person who signs out on a plane is signed
/// out of this device, and the session ages out on its own.
#[tokio::test]
async fn signing_out_with_no_server_still_forgets_this_device() {
    let root = temp_root();
    let secrets = TestSecrets::holding("live", [9u8; 32]);
    let setup = HostedSetup::at("http://127.0.0.1:9")
        .unwrap()
        .with_secrets(Arc::clone(&secrets) as Arc<dyn VaultSecrets>);
    signed_in(&setup);

    setup
        .sign_out(&crate::SyncSession::new(), &root)
        .await
        .expect("sign out with no server");

    assert_eq!(secrets.vault_key().unwrap(), None);
    assert_eq!(secrets.session_token().unwrap(), None);
    assert!(setup.session().is_none());
    let _ = std::fs::remove_dir_all(&root);
}

/// A setup built only to probe or sign in has nowhere to put a vault key, and
/// says so rather than appearing to succeed and forgetting on the next start.
#[tokio::test]
async fn a_setup_with_no_secret_store_will_not_pretend_to_keep_one() {
    let setup = HostedSetup::at("https://notes-sync.futo.org").unwrap();
    signed_in(&setup);

    assert!(matches!(
        setup.current_step().await.unwrap_err(),
        HostedError::SecretStore(_)
    ));
}

/// What a shell asks at a cold start, before it has a network or a reason to
/// use one: is this vault hosted and already unlocked? Both secrets or nothing —
/// a token without a key cannot decrypt and a key without a token cannot
/// authenticate, so either alone is not a vault this device can resume.
///
/// The proof that it is local is the address: nothing listens on port 9, so a
/// read that reached the network would answer `Network` instead of `true`.
#[tokio::test]
async fn a_saved_vault_is_both_secrets_and_is_read_without_the_network() {
    let secrets = Arc::new(TestSecrets::default());
    let setup = HostedSetup::at("http://127.0.0.1:9")
        .unwrap()
        .with_secrets(Arc::clone(&secrets) as Arc<dyn VaultSecrets>);

    assert!(
        !setup.has_saved_vault().await.unwrap(),
        "a device that has never been set up reported a saved vault"
    );

    secrets.set_vault_key(&[7u8; 32]).unwrap();
    assert!(
        !setup.has_saved_vault().await.unwrap(),
        "a vault key with no session token is not a vault this device can resume"
    );

    secrets.delete_vault_key().unwrap();
    secrets.set_session_token("live").unwrap();
    assert!(
        !setup.has_saved_vault().await.unwrap(),
        "a session token with no vault key is not a vault this device can resume"
    );

    secrets.set_vault_key(&[7u8; 32]).unwrap();
    assert!(
        setup.has_saved_vault().await.unwrap(),
        "a device holding both secrets did not recognise its own hosted vault"
    );
}

/// A setup built only to probe has nowhere to have kept a secret, and says so
/// rather than answering "no vault" — which a shell would read as "this person
/// never set up hosted sync" and act on.
#[tokio::test]
async fn a_saved_vault_cannot_be_read_without_a_secret_store() {
    let setup = HostedSetup::at("http://127.0.0.1:9").unwrap();
    assert!(matches!(
        setup.has_saved_vault().await.unwrap_err(),
        HostedError::SecretStore(_)
    ));
}

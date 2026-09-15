//! Tests that need to see inside the crate. The hosted flow's own scenarios
//! live in `tests/hosted_setup.rs`, which drives the public surface against a
//! stub of the server's hosted routes.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

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

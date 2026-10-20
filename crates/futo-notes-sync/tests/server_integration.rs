//! Production-readiness suite: drives the FULL sync-server API through the real
//! native Rust `SyncSession` path against a live server,
//! plus raw-HTTP checks for endpoints the native client doesn't wrap and the
//! error contract.
//!
//! Gated on `FUTO_TEST_SERVER` (a DEV-mode server) and, for the hosted
//! scenarios at the bottom, `FUTO_TEST_HOSTED_SERVER` (a STAND-IN-mode one).
//! Run single-threaded (shared dev vault, and one stand-in account):
//!
//!   node tests/sync-integration.mjs        # starts both servers, runs both families
//!
//! or by hand against a server you already have:
//!   FUTO_TEST_SERVER=http://127.0.0.1:3005 \
//!     cargo test -p futo-notes-sync --test server_integration -- --ignored --test-threads=1

mod common;
mod hosted_scenarios;

use std::path::Path;
use std::path::PathBuf;

use futo_notes_sync::ConnectedState;
use futo_notes_sync::SyncProgress;

/// No-op sync hooks (no progress UI, no watcher to suppress in the test).
fn no_progress(_p: SyncProgress) {}
fn no_pre_write(_f: &str) {}

/// Connect a fresh throwaway client (its own empty vault).
async fn fresh_client(server: &str) -> (ConnectedState, PathBuf) {
    let vault = common::temp_vault();
    let (state, _info) = futo_notes_sync::connect(&vault, server, common::TEST_PASSWORD)
        .await
        .expect("connect");
    (state, vault)
}

async fn pull(state: &ConnectedState, vault: &Path) -> ConnectedState {
    futo_notes_sync::run_pull(state, vault, state.pull_cursor, &no_progress, &no_pre_write)
        .await
        .expect("pull")
        .1
}

async fn dev_login(server: &str) -> String {
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{server}/api/auth/dev/login"))
        .json(&serde_json::json!({"email":"local@futo-notes.local","name":"FUTO Notes"}))
        .send()
        .await
        .expect("dev login");
    let v: serde_json::Value = res.json().await.expect("login json");
    v["token"].as_str().expect("token").to_owned()
}

async fn create_collection_raw(server: &str, token: &str) -> String {
    let res = reqwest::Client::new()
        .post(format!("{server}/api/collections"))
        .bearer_auth(token)
        .send()
        .await
        .expect("create collection");
    let v: serde_json::Value = res.json().await.expect("collection json");
    v["collection"]["id"]
        .as_str()
        .expect("collection id")
        .to_owned()
}

async fn post_blob_object_raw(server: &str, token: &str, cid: &str, body: &[u8]) {
    let res = reqwest::Client::new()
        .post(format!("{server}/api/collections/{cid}/blob-objects"))
        .bearer_auth(token)
        .header("content-type", "application/octet-stream")
        .body(body.to_vec())
        .send()
        .await
        .expect("post blob object");
    assert!(
        res.status().is_success(),
        "post blob-object failed: {}",
        res.status()
    );
}

/// Delete every collection the token's user owns (test cleanup so a keyless or
/// stale vault doesn't leak into the shared singleton dev user's next test).
async fn delete_all_collections_raw(server: &str, token: &str) {
    let http = reqwest::Client::new();
    let res = http
        .get(format!("{server}/api/collections"))
        .bearer_auth(token)
        .send()
        .await
        .expect("list collections");
    let v: serde_json::Value = res.json().await.expect("collections json");
    if let Some(arr) = v["collections"].as_array() {
        for c in arr {
            if let Some(id) = c["id"].as_str() {
                let _ = http
                    .delete(format!("{server}/api/collections/{id}"))
                    .bearer_auth(token)
                    .send()
                    .await;
            }
        }
    }
}

#[path = "server_integration/connect.rs"]
mod connect;
#[path = "server_integration/name_collisions.rs"]
mod name_collisions;
#[path = "server_integration/oversize_blob.rs"]
mod oversize_blob;
#[path = "server_integration/perf.rs"]
mod perf;
#[path = "server_integration/push_first.rs"]
mod push_first;
#[path = "server_integration/raw_http.rs"]
mod raw_http;
#[path = "server_integration/reconnect.rs"]
mod reconnect;
#[path = "server_integration/round_trip.rs"]
mod round_trip;

/// Conflict copies minted for `file` ("name.md" → "name (conflict …).md")
/// present in `vault`. Scoped to the file's own stem because the integration
/// server's collection is shared across tests.
fn conflict_copies_of(vault: &Path, file: &str) -> Vec<String> {
    let stem = file.strip_suffix(".md").unwrap_or(file);
    let prefix = format!("{stem} (conflict");
    std::fs::read_dir(vault)
        .expect("read vault dir")
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| name.starts_with(&prefix))
        .collect()
}

// ── Hosted setup (Log in with FUTO, billing, checkout) ────────────────────
//
// The same scenario bodies `hosted_setup.rs` runs against the in-test stub,
// run here against a REAL server started in stand-in test mode.
//
// This file therefore drives TWO servers, because the two families need two
// modes that cannot be one process: everything above authenticates through the
// dev login on $FUTO_TEST_SERVER, and a hosted server answers those
// `Auth("unauthorized")`; everything below needs Log in with FUTO and a
// billing provider on $FUTO_TEST_HOSTED_SERVER, which a dev-mode server does
// not mount. `node tests/sync-integration.mjs` starts both and sets both, so
// one command runs the file. By hand:
//
//   STANDIN_MODE=true DATABASE_URL=sqlite:/tmp/standin.db PORT=3077 futo-notes-server
//   FUTO_TEST_HOSTED_SERVER=http://127.0.0.1:3077 cargo test -p futo-notes-sync \
//     --test server_integration -- --ignored --test-threads=1
//
// Run single-threaded: a stand-in server has ONE account, so two scenarios in
// flight would fight over its entitlement.

/// Base URL of the STAND-IN-mode server the hosted scenarios need, or `None`
/// when they should skip. Deliberately a different variable from
/// `FUTO_TEST_SERVER`: the two modes are mutually exclusive in one server
/// process. It lives here rather than in `common`, which `sse_live.rs` shares
/// and which has no hosted scenarios.
fn hosted_server_url() -> Option<String> {
    match std::env::var("FUTO_TEST_HOSTED_SERVER") {
        Ok(s) if !s.trim().is_empty() => Some(s),
        _ => None,
    }
}

/// The stand-in server to run a hosted scenario against, or `None` when there
/// is none configured and the scenario should skip.
///
/// An UNSET variable skips, because the pinned server release may predate
/// stand-in test mode. A variable that is SET and does not answer as a hosted
/// server is a hard failure — somebody asked for this run, so a wrong or dead
/// server must be red rather than a line nobody reads (M11).
async fn hosted_server_or_skip(test: &str) -> Option<String> {
    let Some(server) = hosted_server_url() else {
        eprintln!(
            "[skip] {test}: set FUTO_TEST_HOSTED_SERVER to a stand-in-mode server to run \
             (node tests/sync-integration.mjs does)"
        );
        return None;
    };
    match futo_notes_sync::probe_sign_in_flow(&server).await {
        Ok(futo_notes_sync::SignInFlow::Hosted { .. }) => Some(server),
        Ok(other) => panic!(
            "FUTO_TEST_HOSTED_SERVER={server} offers {other:?}, not hosted sign-in. \
             It must be a server started with STANDIN_MODE=true."
        ),
        Err(error) => panic!("could not probe FUTO_TEST_HOSTED_SERVER={server}: {error}"),
    }
}

macro_rules! against_the_real_server {
    ($($name:ident,)+) => {
        $(
            #[tokio::test]
            #[ignore = "requires a stand-in-mode FUTO_TEST_HOSTED_SERVER"]
            async fn $name() {
                let Some(server) = hosted_server_or_skip(stringify!($name)).await else {
                    return;
                };
                hosted_scenarios::$name(&server).await;
            }
        )+
    };
}

against_the_real_server! {
    the_probe_offers_hosted_sign_in,
    sign_in_then_subscribe,
    a_dismissed_sheet_cancels_the_wait,
    a_spent_ticket_is_reported_as_expired,
    an_entitled_account_is_not_sent_to_pay_again,
    the_account_card_can_open_the_billing_portal,
    a_lapsed_subscription_is_readable_and_not_a_sign_out,
    a_fresh_account_creates_a_vault,
    the_recovery_key_cannot_be_asked_for_twice,
    creating_a_vault_without_a_subscription_is_refused,
    a_short_vault_password_is_refused_before_anything_is_written,
    a_second_device_unlocks_with_the_vault_password,
    a_second_device_unlocks_with_the_recovery_key,
    quitting_mid_wizard_resumes_at_the_right_step,
    signing_out_forgets_the_key_the_token_and_the_live_state,
    a_set_up_vault_starts_syncing,
    a_locked_device_cannot_start_syncing,
    finishing_hosted_setup_clears_the_self_hosted_password,
    a_finished_wizard_is_recognised_without_the_network,
    // QR pairing. Two of the stub's pairing scenarios are missing here on
    // purpose: `an_expired_pairing_code_is_its_own_error` needs a window
    // shorter than the relay's five minutes, and
    // `another_accounts_live_pairing_is_refused` needs a second account, and a
    // stand-in server has exactly one identity (its ADR 0009). Both run
    // against the stub in `tests/hosted_setup.rs`.
    pairing_hands_the_vault_key_to_a_new_device,
    a_scanned_code_sends_nothing_until_the_person_confirms,
    a_scan_that_is_not_a_pairing_code_sends_nothing,
    a_pairing_this_account_cannot_reach_is_refused,
    a_pairing_can_only_be_answered_once,
    collecting_the_key_spends_the_pairing,
    leaving_the_pairing_screen_cancels_the_wait,
    // Changing the vault password, and issuing a new recovery key.
    a_new_vault_password_replaces_the_old_one,
    changing_the_vault_password_keeps_the_recovery_key_working,
    a_new_recovery_key_invalidates_the_old_one,
    a_stale_key_revision_is_refused_and_clears_on_retry,
    a_stale_recovery_key_revision_is_refused,
    a_locked_device_cannot_change_the_vault_password,
    changing_the_vault_password_leaves_another_device_untouched,
    // Real-server only: the hosted stub mounts the setup routes and nothing
    // else, so there is no object API on it to run a sync cycle against.
    changing_the_vault_password_leaves_another_device_syncing,
}

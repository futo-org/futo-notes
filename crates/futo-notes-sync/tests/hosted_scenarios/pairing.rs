//! QR pairing: the new device shows, the unlocked device scans.

use super::*;

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
    let request = laptop.request_wait();
    let waiting = tokio::spawn({
        let laptop = Arc::clone(&laptop);
        async move { laptop.await_pairing(request).await }
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
        laptop
            .await_pairing(laptop.request_wait())
            .await
            .unwrap_err(),
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
        laptop
            .await_pairing(laptop.request_wait())
            .await
            .expect("await pairing"),
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
        laptop
            .await_pairing(laptop.request_wait())
            .await
            .expect("await pairing"),
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

    let request = laptop.request_wait();
    let waiting = tokio::spawn({
        let laptop = Arc::clone(&laptop);
        async move { laptop.await_pairing(request).await }
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
        laptop
            .await_pairing(laptop.request_wait())
            .await
            .unwrap_err(),
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

//! The hosted-setup scenarios, written once and run twice: against the
//! in-test stub (`tests/hosted_setup.rs`, which is what CI gets) and against a
//! real server in stand-in test mode (`tests/server_integration.rs`, gated on
//! `FUTO_TEST_SERVER`).
//!
//! They drive the public surface a shell would call and assert on what a
//! person would observe — which step the flow reached, whether the account may
//! write — never on HTTP call order or state-machine internals.

use std::sync::Arc;
use std::time::Duration;

use futo_notes_sync::{
    probe_sign_in_flow, BillingStatus, Checkout, EntitlementOutcome, HostedSetup, PollSchedule,
    SignInFlow, SignInOutcome,
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
    let handoff = setup.begin_sign_in().await.expect("begin sign in");
    browser_visit(&handoff.url).await;
    match setup.await_sign_in(&handoff).await.expect("await sign in") {
        SignInOutcome::SignedIn(_) => setup,
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

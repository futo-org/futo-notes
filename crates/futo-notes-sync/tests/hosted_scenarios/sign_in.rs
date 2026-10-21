//! Signing in, subscribing, and reading the account's billing.

use super::*;

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

    let handoff = mint_handoff(&setup).await;
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
    let handoff = mint_handoff(&setup).await;

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
    let handoff = mint_handoff(&first).await;
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
/// writes no billing state, so canceling, invoices, and cards all live behind
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

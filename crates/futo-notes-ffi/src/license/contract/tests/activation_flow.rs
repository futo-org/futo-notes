//! Deep links and key entry: what is accepted, rejected, or sent over the network.

use super::*;

#[test]
fn a_link_at_an_undefined_path_is_ignored_silently() {
    let transport = RecordingTransport::failing("no network in this test");

    let outcome = handle_deep_link_with(
        "futonotes://settings/open",
        DEV_BUNDLE_ID,
        during_term(),
        &transport,
    );

    assert_eq!(outcome, LicenseLinkOutcome::Ignored);
    assert!(transport.requests().is_empty());
}

#[test]
fn another_apps_scheme_is_ignored_silently() {
    let outcome = handle_deep_link_with(
        "grayjay://license/FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78/v2.a.b",
        DEV_BUNDLE_ID,
        during_term(),
        &RecordingTransport::failing("no network in this test"),
    );

    assert_eq!(outcome, LicenseLinkOutcome::Ignored);
}

/// A link at the DEFINED path that does not verify is the one case that
/// earns a toast. Ignored would swallow it; Accepted would store garbage.
#[test]
fn a_license_link_that_does_not_verify_is_rejected() {
    let outcome = handle_deep_link_with(
        &format!("futonotes://license/{KEY}/v2.bm90LWEtbGljZW5zZQ.bm90LWEtc2ln"),
        DEV_BUNDLE_ID,
        during_term(),
        &RecordingTransport::failing("no network in this test"),
    );

    assert_eq!(outcome, LicenseLinkOutcome::Rejected);
}

/// The pair a shell stores must be what arrived, byte for byte: base64url
/// is case-sensitive, and an activation "helpfully" normalized on the way
/// through stops verifying on the next launch.
#[test]
fn a_valid_link_is_accepted_with_the_pair_to_store() {
    let outcome = handle_deep_link_with(
        &format!("futonotes://license/{KEY}/{ACTIVATION}"),
        DEV_BUNDLE_ID,
        during_term(),
        &RecordingTransport::failing("no network in this test"),
    );

    let LicenseLinkOutcome::Accepted { acceptance } = outcome else {
        panic!("expected the link to be accepted, got {outcome:?}");
    };
    assert_eq!(acceptance.pair.key, KEY);
    assert_eq!(acceptance.pair.activation, ACTIVATION);
    assert_eq!(acceptance.view.status, LicenseStatus::Licensed);
}

/// Zero background network is the rule that makes this module safe to call
/// from a URL handler at launch. A link carries its activation, so it
/// verifies offline — this is the test that goes red if the link path ever
/// starts activating.
#[test]
fn no_request_is_made_for_a_deep_link() {
    let transport = RecordingTransport::answering(200, ACTIVATION);

    handle_deep_link_with(
        &format!("futonotes://license/{KEY}/{ACTIVATION}"),
        DEV_BUNDLE_ID,
        during_term(),
        &transport,
    );

    assert_eq!(transport.requests(), Vec::<String>::new());
}

#[test]
fn a_pasted_pair_never_reaches_the_network() {
    let transport = RecordingTransport::answering(200, ACTIVATION);

    let accepted = enter_key_with(
        &format!("{KEY}/{ACTIVATION}"),
        DEV_BUNDLE_ID,
        during_term(),
        &transport,
    )
    .unwrap();

    assert_eq!(accepted.view.status, LicenseStatus::Licensed);
    assert_eq!(transport.requests(), Vec::<String>::new());
}

/// The bare-key path is the only network in the whole license module:
/// exactly one GET, at the staging host because the bundle id says `.dev`,
/// and then the returned pair is verified before it is handed back.
#[test]
fn a_bare_key_makes_exactly_one_staging_request() {
    let transport = RecordingTransport::answering(200, ACTIVATION);

    let accepted = enter_key_with(KEY, DEV_BUNDLE_ID, during_term(), &transport).unwrap();

    assert_eq!(
        transport.requests(),
        vec![format!(
            "https://staging-pay2.futo.org/api/v1/activate/{KEY}"
        )]
    );
    assert_eq!(accepted.pair.activation, ACTIVATION);
    assert_eq!(accepted.view.status, LicenseStatus::Licensed);
}

/// The spec gives a 404 and a failed verification the SAME message, and
/// reserves "connect to the internet" for a request that did not complete.
/// Getting this backwards tells a user with a typo'd key to check their
/// network.
#[test]
fn a_rejected_key_and_a_missing_key_share_one_error() {
    let missing = enter_key_with(
        KEY,
        DEV_BUNDLE_ID,
        during_term(),
        &RecordingTransport::answering(404, "not found"),
    );
    let rubbish = enter_key_with(
        "not a license",
        DEV_BUNDLE_ID,
        during_term(),
        &RecordingTransport::failing("no network in this test"),
    );

    assert_eq!(missing, Err(LicenseError::Invalid));
    assert_eq!(rubbish, Err(LicenseError::Invalid));
}

#[test]
fn a_request_that_did_not_complete_asks_the_user_to_connect() {
    let entered = enter_key_with(
        KEY,
        DEV_BUNDLE_ID,
        during_term(),
        &RecordingTransport::failing("dns failure"),
    );

    assert!(
        matches!(entered, Err(LicenseError::Offline { .. })),
        "expected Offline, got {entered:?}"
    );
}

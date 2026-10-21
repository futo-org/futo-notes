//! Version 1 activations: licensed with no dates, never expiring.

use super::*;

/// The reversal this projection exists to carry across the boundary: a v1
/// activation is Licensed, and BOTH timestamps arrive absent. A shell that
/// received `Some(now)` here would render a year nobody bought anything in.
#[test]
fn a_v1_license_is_licensed_with_no_dates_at_all() {
    let view = evaluate_at(Some(pair(V1_ACTIVATION)), DEV_BUNDLE_ID, during_term());

    assert_eq!(view.status, LicenseStatus::Licensed);
    assert_eq!(view.issued_at_millis, None);
    assert_eq!(view.expires_at_millis, None);
}

/// v1 cannot express an expiry, so no clock ever moves it out of Licensed.
/// Expired stays reachable only for a v2 activation carrying `expires_at`.
#[test]
fn a_v1_license_never_expires() {
    let view = evaluate_at(Some(pair(V1_ACTIVATION)), DEV_BUNDLE_ID, after_term());

    assert_eq!(view.status, LicenseStatus::Licensed);
    assert_eq!(view.expires_at_millis, None);
}

/// CRITICAL (M3). v1 verifies against the same org key as v2, so the
/// dev/prod split has to hold for it too — a staging v1 activation must
/// fail closed on a release build.
#[test]
fn the_bundle_id_is_the_dev_prod_split_for_v1_too() {
    let on_dev = evaluate_at(Some(pair(V1_ACTIVATION)), DEV_BUNDLE_ID, during_term());
    let on_release = evaluate_at(Some(pair(V1_ACTIVATION)), RELEASE_BUNDLE_ID, during_term());

    assert_eq!(on_dev.status, LicenseStatus::Licensed);
    assert_eq!(on_release, unlicensed());
}

/// A v1 signature covers the key string alone, so pasting it against any
/// other key fails verification — the format's own stand-in for a key
/// mismatch.
#[test]
fn a_v1_activation_does_not_license_a_different_key() {
    let mismatched = LicensePair {
        key: "FN-ZZ99-YY88-XX77-WW66-VV55-UU44-TT33-SS22".to_string(),
        activation: V1_ACTIVATION.to_string(),
    };

    let view = evaluate_at(Some(mismatched), DEV_BUNDLE_ID, during_term());

    assert_eq!(view, unlicensed());
}

/// Both entry paths reach the same crate call, so both must accept both
/// formats: the deep link the checkout page opens, and the one bare-key
/// request whose response the deployed server returns in v1.
#[test]
fn a_v1_link_is_accepted_and_a_v1_activation_response_is_too() {
    let outcome = handle_deep_link_with(
        &format!("futonotes://license/{KEY}/{V1_ACTIVATION}"),
        DEV_BUNDLE_ID,
        during_term(),
        &RecordingTransport::failing("no network in this test"),
    );

    let LicenseLinkOutcome::Accepted { acceptance } = outcome else {
        panic!("expected the v1 link to be accepted, got {outcome:?}");
    };
    assert_eq!(acceptance.pair.activation, V1_ACTIVATION);
    assert_eq!(acceptance.view.status, LicenseStatus::Licensed);
    assert_eq!(acceptance.view.issued_at_millis, None);

    let transport = RecordingTransport::answering(200, V1_ACTIVATION);
    let entered = enter_key_with(KEY, DEV_BUNDLE_ID, during_term(), &transport).unwrap();

    assert_eq!(entered.pair.activation, V1_ACTIVATION);
    assert_eq!(entered.view.status, LicenseStatus::Licensed);
    assert_eq!(entered.view.issued_at_millis, None);
}

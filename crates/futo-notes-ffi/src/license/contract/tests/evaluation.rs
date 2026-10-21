//! Evaluating a stored pair: the dates, the key, and the dev/prod split.

use super::*;

#[test]
fn nothing_stored_is_unlicensed() {
    let view = evaluate_at(None, DEV_BUNDLE_ID, during_term());

    assert_eq!(view.status, LicenseStatus::Unlicensed);
    assert_eq!(view.issued_at_millis, None);
    assert_eq!(view.expires_at_millis, None);
}

/// `InvalidReason` is diagnostic only: a stored pair that no longer
/// verifies must look exactly like no license, never leak a reason.
#[test]
fn a_stored_pair_that_no_longer_verifies_looks_like_no_license() {
    let tampered = pair(&ACTIVATION.replace("v2.eyJrZXki", "v2.eyJrZXkx"));

    let view = evaluate_at(Some(tampered), DEV_BUNDLE_ID, during_term());

    assert_eq!(view, unlicensed());
}

/// "Licensed since {date}" and "Valid until {date}" both come from the
/// payload, so both timestamps have to cross the boundary in a form a
/// shell can parse.
#[test]
fn a_licensed_pair_carries_both_timestamps() {
    let view = evaluate_at(Some(pair(ACTIVATION)), DEV_BUNDLE_ID, during_term());

    assert_eq!(view.status, LicenseStatus::Licensed);
    assert_eq!(view.issued_at_millis, Some(ISSUED_AT_MILLIS));
    assert_eq!(view.expires_at_millis, Some(EXPIRES_AT_MILLIS));
}

/// A perpetual product has no expiry and the row must not invent one.
#[test]
fn a_perpetual_license_reports_no_expiry() {
    let view = evaluate_at(
        Some(pair(PERPETUAL_ACTIVATION)),
        DEV_BUNDLE_ID,
        after_term(),
    );

    assert_eq!(view.status, LicenseStatus::Licensed);
    assert_eq!(view.expires_at_millis, None);
}

/// An expired license is kept on the device and still says "Supporter
/// since", so it keeps both dates too.
#[test]
fn an_expired_license_keeps_its_dates() {
    let view = evaluate_at(Some(pair(ACTIVATION)), DEV_BUNDLE_ID, after_term());

    assert_eq!(view.status, LicenseStatus::Expired);
    assert_eq!(view.issued_at_millis, Some(ISSUED_AT_MILLIS));
    assert_eq!(view.expires_at_millis, Some(EXPIRES_AT_MILLIS));
}

/// The card renders the stored key (masked, revealable), so it crosses on
/// this record rather than being read back out of each shell's own
/// storage. It crosses **normalized**: a lower-cased or padded paste is
/// stored and shown in the one form the crate defines, so the row can
/// never disagree with what would be re-sent to the activation endpoint.
#[test]
fn a_licensed_view_carries_the_normalized_key() {
    let untidy = LicensePair {
        key: format!("  {}  ", KEY.to_lowercase()),
        activation: ACTIVATION.to_string(),
    };

    let view = evaluate_at(Some(untidy), DEV_BUNDLE_ID, during_term());

    assert_eq!(view.status, LicenseStatus::Licensed);
    assert_eq!(view.key.as_deref(), Some(KEY));
}

/// An expired license is kept on the device, so its key is still there to
/// show — the card asks the user to renew THAT key.
#[test]
fn an_expired_view_keeps_its_key() {
    let view = evaluate_at(Some(pair(ACTIVATION)), DEV_BUNDLE_ID, after_term());

    assert_eq!(view.status, LicenseStatus::Expired);
    assert_eq!(view.key.as_deref(), Some(KEY));
}

/// Unlicensed has no key to show — and neither does a stored pair that
/// stopped verifying, including one from the other environment (M3).
/// Rendering the key of a license this build just refused would tell the
/// user they hold something the app does not honor.
#[test]
fn an_unlicensed_view_carries_no_key() {
    assert_eq!(evaluate_at(None, DEV_BUNDLE_ID, during_term()).key, None);
    assert_eq!(
        evaluate_at(Some(pair(ACTIVATION)), RELEASE_BUNDLE_ID, during_term()).key,
        None
    );
}

/// CRITICAL (M3). The same staging license must verify on a `.dev` build
/// and fail closed on a release build — and the selector is the bundle id
/// the shell passes, never a compile profile: both native dev apps are
/// built with the optimized `release-ffi` profile.
#[test]
fn the_bundle_id_is_the_dev_prod_split() {
    let on_dev = evaluate_at(Some(pair(ACTIVATION)), DEV_BUNDLE_ID, during_term());
    let on_release = evaluate_at(Some(pair(ACTIVATION)), RELEASE_BUNDLE_ID, during_term());

    assert_eq!(on_dev.status, LicenseStatus::Licensed);
    assert_eq!(on_release, unlicensed());
}

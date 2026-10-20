//! The contract's values are the license crate's rules, passed through.

use super::*;

#[test]
fn evidence_maps_through_to_the_crate_rule() {
    let owned = LicenseEvidence {
        key: LicenseStatus::Expired,
        app_store: true,
    };
    assert_eq!(license_plate(owned), LicensePlate::AppStore);
    assert_eq!(
        license_evidence_includes(owned),
        license_includes(LicenseStatus::Licensed)
    );
    assert_eq!(license_app_store_product_id(), "com.futo.notes.license");
}

#[test]
fn the_purchase_surface_maps_through_to_the_crate_rule() {
    use LicenseDistribution::*;
    use LicensePurchaseSurface::*;
    assert_eq!(license_purchase_surface(AndroidPlay, None), NameWebsite);
    assert_eq!(
        license_purchase_surface(AndroidPlay, Some("USA".into())),
        NameWebsite
    );
    assert_eq!(license_purchase_surface(AndroidDirect, None), LinkOut);
    assert_eq!(license_purchase_surface(Desktop, None), LinkOut);
    assert_eq!(
        license_purchase_surface(IosAppStore, Some("USA".into())),
        LinkOut
    );
    assert_eq!(license_purchase_surface(IosAppStore, None), KeyOnly);
}

/// The display address is environment-split like Buy (M3).
#[test]
fn the_website_is_named_per_environment() {
    let links =
        |id: &str| license_links(LicensePlatform::Android, id.into(), BuySource::LicenseCard);
    assert_eq!(links("com.futo.notes").website, "pay.futo.org");
    assert_eq!(links("com.futo.notes.dev").website, "staging-pay2.futo.org");
}

/// `link_out = false` is the consumption-only shape: it hides Buy, Renew
/// and Lost-your-key, and keeps
/// the key field (and the deep link, which is not a control at all).
#[test]
fn link_out_false_hides_every_way_out_of_the_app_and_nothing_else() {
    assert_eq!(
        license_row_actions(LicenseStatus::Unlicensed, false),
        vec![LicenseAction::EnterKey]
    );
    assert_eq!(
        license_row_actions(LicenseStatus::Expired, false),
        vec![LicenseAction::EnterKey]
    );
    // Remove is not a way out of the app, so it must survive the flag.
    assert_eq!(
        license_row_actions(LicenseStatus::Licensed, false),
        vec![LicenseAction::Remove]
    );
}

#[test]
fn the_buy_url_carries_the_platform() {
    assert_eq!(
        license_links(
            LicensePlatform::Ios,
            "com.futo.notes".into(),
            BuySource::LicenseCard
        )
        .buy,
        "https://pay2.futo.org/checkout/polar/futo-notes/futo-notes-license\
             /checkout-ready?platform=ios&from=license-card&success=redirect-to-organization-page"
    );
    assert_eq!(
            license_links(LicensePlatform::Android, "com.futo.notes".into(), BuySource::LicenseCard).buy,
            "https://pay2.futo.org/checkout/polar/futo-notes/futo-notes-license\
             /checkout-ready?platform=android&from=license-card&success=redirect-to-organization-page"
        );
    assert_eq!(
        license_links(
            LicensePlatform::Ios,
            "com.futo.notes".into(),
            BuySource::LicenseCard
        )
        .support,
        "mailto:support@futo.tech"
    );
}

#[test]
fn the_buy_url_carries_the_source() {
    assert!(license_links(
        LicensePlatform::Ios,
        "com.futo.notes".into(),
        BuySource::AppIconPicker
    )
    .buy
    .contains("&from=app-icon&"));
}

/// The FFI mapping, not the policy (the crate owns that): a status reaches
/// the crate's rule as the same status, and the answer comes back mapped.
#[test]
fn includes_maps_the_status_through_to_the_crate_rule() {
    assert_eq!(
        license_includes(LicenseStatus::Licensed),
        vec![LicenseInclusion::AppIcon]
    );
    assert!(license_includes(LicenseStatus::Expired).is_empty());
}

/// The defect this split fixed: a `.dev` build's Buy button opened the
/// production storefront, so staging checkout was unreachable from the app
/// that verifies against the staging key (M3).
#[test]
fn a_dev_build_buys_on_staging() {
    assert_eq!(
            license_links(LicensePlatform::Android, "com.futo.notes.dev".into(), BuySource::LicenseCard).buy,
            "https://staging-pay2.futo.org/checkout/polar/futo-notes/futo-notes-license\
             /checkout-ready?platform=android&from=license-card&success=redirect-to-organization-page"
        );
}

/// The shells register this scheme at BUILD time (`CFBundleURLTypes`, an
/// intent filter), so they need the crate's answer to assert against.
#[test]
fn the_registered_scheme_is_the_crates_scheme() {
    assert_eq!(license_deep_link_scheme(), "futonotes");
}

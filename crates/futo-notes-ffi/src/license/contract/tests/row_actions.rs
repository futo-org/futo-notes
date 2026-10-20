//! The row's actions, the storefront link-out rule, and the App Store purchase.

use super::*;

/// The spec's States-and-copy table, in the order the row renders.
#[test]
fn the_row_actions_are_the_specified_table() {
    assert_eq!(
        license_row_actions(LicenseStatus::Unlicensed, true),
        vec![
            LicenseAction::Buy,
            LicenseAction::EnterKey,
            LicenseAction::LostKey
        ]
    );
    assert_eq!(
        license_row_actions(LicenseStatus::Licensed, true),
        vec![LicenseAction::Remove]
    );
    assert_eq!(
        license_row_actions(LicenseStatus::Expired, true),
        vec![
            LicenseAction::Renew,
            LicenseAction::EnterKey,
            LicenseAction::LostKey
        ]
    );
}

#[test]
fn storefront_link_out_fails_closed_and_follows_the_distribution() {
    for country in [None, Some("FRA"), Some("JPN"), Some(""), Some("usa")] {
        assert!(!license_link_out(
            LicensePlatform::Ios,
            country.map(str::to_owned),
            true
        ));
    }
    assert!(license_link_out(
        LicensePlatform::Ios,
        Some("USA".into()),
        true
    ));
    assert!(!license_link_out(
        LicensePlatform::Ios,
        Some("USA".into()),
        false
    ));
    assert!(license_link_out(LicensePlatform::Android, None, true));
    assert!(!license_link_out(
        LicensePlatform::Android,
        Some("USA".into()),
        false
    ));
    assert!(license_link_out(LicensePlatform::Desktop, None, false));
}

/// The full table per surface. `play` names the website: no Buy or Renew,
/// but "Lost your key?" stays, because help leads to no payment.
#[test]
fn naming_the_website_keeps_help_and_drops_checkout() {
    use LicensePurchaseSurface::*;
    for status in [LicenseStatus::Unlicensed, LicenseStatus::Expired] {
        assert_eq!(
            license_surface_row_actions(status, NameWebsite),
            vec![LicenseAction::EnterKey, LicenseAction::LostKey]
        );
        assert_eq!(
            license_surface_row_actions(status, KeyOnly),
            vec![LicenseAction::EnterKey]
        );
        assert_eq!(
            license_surface_row_actions(status, LinkOut),
            license_row_actions(status, true)
        );
    }
    for surface in [LinkOut, NameWebsite, KeyOnly] {
        assert_eq!(
            license_surface_row_actions(LicenseStatus::Licensed, surface),
            vec![LicenseAction::Remove]
        );
    }
}

/// The App Store table (docs/plan/license-ios-app-store.md § 4). Display
/// order matters: link-out gives the website and the App Store equal weight
/// side by side; key-only keeps the key field first.
#[test]
fn the_app_store_purchase_joins_the_row_where_it_is_offered() {
    use LicenseAction::*;
    use LicensePurchaseSurface::*;
    let unowned = |key| LicenseEvidence {
        key,
        app_store: false,
    };
    for (key, buy) in [
        (LicenseStatus::Unlicensed, Buy),
        (LicenseStatus::Expired, Renew),
    ] {
        assert_eq!(
            license_evidence_row_actions(unowned(key), LinkOut, true),
            vec![buy, BuyInAppStore, EnterKey, RestorePurchases, LostKey]
        );
        assert_eq!(
            license_evidence_row_actions(unowned(key), KeyOnly, true),
            vec![EnterKey, BuyInAppStore, RestorePurchases]
        );
        // No product loaded (or not iOS): exactly the key-only table.
        for surface in [LinkOut, NameWebsite, KeyOnly] {
            assert_eq!(
                license_evidence_row_actions(unowned(key), surface, false),
                license_surface_row_actions(key, surface)
            );
        }
    }
    for surface in [LinkOut, NameWebsite, KeyOnly] {
        for offered in [true, false] {
            // A purchase cannot be removed from an Apple Account.
            for key in [LicenseStatus::Unlicensed, LicenseStatus::Expired] {
                assert_eq!(
                    license_evidence_row_actions(
                        LicenseEvidence {
                            key,
                            app_store: true
                        },
                        surface,
                        offered
                    ),
                    vec![EnterKey]
                );
            }
            for app_store in [true, false] {
                assert_eq!(
                    license_evidence_row_actions(
                        LicenseEvidence {
                            key: LicenseStatus::Licensed,
                            app_store
                        },
                        surface,
                        offered
                    ),
                    vec![Remove]
                );
            }
        }
    }
}

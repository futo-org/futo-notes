use super::*;

/// The whole truth table. Changing a row is a store-policy decision.
#[test]
fn the_purchase_surface_follows_distribution_and_storefront() {
    use Distribution::*;
    use PurchaseSurface::*;
    for country in [None, Some("USA"), Some("FRA")] {
        assert_eq!(license_purchase_surface(Desktop, country), LinkOut);
        assert_eq!(license_purchase_surface(AndroidDirect, country), LinkOut);
        assert_eq!(license_purchase_surface(AndroidPlay, country), NameWebsite);
    }
    assert_eq!(license_purchase_surface(IosAppStore, Some("USA")), LinkOut);
    for country in [None, Some("FRA"), Some("JPN"), Some(""), Some("usa")] {
        assert_eq!(license_purchase_surface(IosAppStore, country), KeyOnly);
    }
}

#[test]
fn the_website_address_is_split_like_checkout() {
    assert_eq!(Environment::Production.website_address(), "pay.futo.org");
    assert_eq!(
        Environment::Staging.website_address(),
        "staging-pay2.futo.org"
    );
    // Typed by a person and never a link: no scheme, no path.
    for env in [Environment::Production, Environment::Staging] {
        let address = env.website_address();
        assert!(
            !address.contains("://") && !address.contains('/'),
            "{address}"
        );
    }
    // A dev build names the storefront it would buy on.
    assert!(Environment::Staging
        .config()
        .pay2_base_url
        .ends_with(Environment::Staging.website_address()));
}

#[test]
fn checkout_availability_follows_storefront_and_distribution() {
    for country in [None, Some("FRA"), Some("JPN"), Some(""), Some("usa")] {
        assert!(!license_link_out(Platform::Ios, country, true));
    }
    assert!(license_link_out(Platform::Ios, Some("USA"), true));
    assert!(!license_link_out(Platform::Ios, Some("USA"), false));
    assert!(license_link_out(Platform::Android, None, true));
    assert!(!license_link_out(Platform::Android, Some("USA"), false));
    assert!(license_link_out(Platform::Desktop, None, false));
}

/// CRITICAL. The staging constant is the real FUTO Notes staging org key,
/// and this is its identity: SHA-256 over the DER SubjectPublicKeyInfo.
///
/// Every staging-signed artifact in the repo — the iOS and Android
/// `LicenseFixture` pair, the FFI contract tests' activations — was minted
/// against exactly this key and verifies against nothing else. Swapping the
/// constant for another valid key would leave every one of those tests
/// failing with a signature mismatch and no explanation; this fails first,
/// naming what actually changed. The fingerprint is recorded independently
/// in 1Password and in issue #157.
#[test]
fn the_staging_key_is_the_real_staging_org_key() {
    use base64::Engine as _;

    let der = base64::engine::general_purpose::STANDARD
        .decode(STAGING_PUBLIC_KEY_BASE64)
        .expect("the staging constant is standard base64");
    let digest = ring::digest::digest(&ring::digest::SHA256, &der);
    let fingerprint: String = digest.as_ref().iter().map(|b| format!("{b:02x}")).collect();

    assert_eq!(
        fingerprint, "fca4b6a4c48cf730aa5b7cbf7c59145eda30dee9e96414eb9c378dd202e29a23",
        "STAGING_PUBLIC_KEY_BASE64 is not the FUTO Notes staging org key — \
         if this was deliberate, re-mint every staging-signed fixture with \
         `node scripts/gen-license-fixture.mjs --staging` and update this \
         fingerprint in the same commit"
    );
}

/// CRITICAL. The production constant is the real FUTO Notes production org
/// key — the one every shipped release build verifies against. Unlike the
/// staging key, nothing in the repo is signed by it (no production-signed
/// activation is ever committed), so without this pin a wrong key would
/// pass every test and show every paying user Unlicensed.
#[test]
fn the_production_key_is_the_real_production_org_key() {
    use base64::Engine as _;

    let der = base64::engine::general_purpose::STANDARD
        .decode(PRODUCTION_PUBLIC_KEY_BASE64)
        .expect("the production constant is standard base64");
    let digest = ring::digest::digest(&ring::digest::SHA256, &der);
    let fingerprint: String = digest.as_ref().iter().map(|b| format!("{b:02x}")).collect();

    assert_eq!(
        fingerprint, "2034d795d4c4201da026791017ef12be4b8834372af8bf46cf064371b7f6aa68",
        "PRODUCTION_PUBLIC_KEY_BASE64 is not the FUTO Notes production org key \
         served by pay2.futo.org/checkout/polar/futo-notes/activation/public-key"
    );
}

#[test]
fn a_dev_bundle_id_never_lands_on_the_production_key() {
    assert_eq!(
        Environment::from_bundle_suffix("com.futo.notes.dev"),
        Environment::Staging
    );
    assert_eq!(
        Environment::from_bundle_suffix("com.futo.notes"),
        Environment::Production
    );
    // Not a suffix match on the word, and not fooled by stray whitespace.
    assert_eq!(
        Environment::from_bundle_suffix("com.futo.notes.development"),
        Environment::Production
    );
    assert_eq!(
        Environment::from_bundle_suffix(" com.futo.notes.dev "),
        Environment::Staging
    );
}

#[test]
fn the_build_flag_beats_the_bundle_id_and_only_when_set() {
    let expected =
        |bundle_id| LICENSE_ENV_OVERRIDE.unwrap_or(Environment::from_bundle_suffix(bundle_id));
    for bundle_id in ["com.futo.notes", "com.futo.notes.dev"] {
        assert_eq!(Environment::for_bundle_id(bundle_id), expected(bundle_id));
    }
    assert_eq!(
        Environment::parse_flag("staging"),
        Some(Environment::Staging)
    );
    assert_eq!(
        Environment::parse_flag("production"),
        Some(Environment::Production)
    );
    assert_eq!(
        Environment::parse_flag("prod"),
        Some(Environment::Production)
    );
    assert_eq!(Environment::parse_flag("Production"), None);
    assert_eq!(Environment::parse_flag(""), None);
}

/// The activation payload's product field and the checkout URL's product
/// segment are different strings for different jobs. Unifying them breaks
/// one of the two: `PRODUCT_SLUG` is matched against bytes the server
/// already signed, `CHECKOUT_PRODUCT_SLUG` is a path segment on the
/// storefront.
#[test]
fn the_checkout_slug_is_not_the_activation_payloads_product() {
    assert_ne!(PRODUCT_SLUG, CHECKOUT_PRODUCT_SLUG);
    assert!(buy_url(
        Environment::Staging.config(),
        Platform::Desktop,
        BuySource::LicenseCard
    )
    .contains("/futo-notes/futo-notes-license/"));
}

#[test]
fn a_dev_build_can_never_open_production_checkout() {
    let staging = buy_url(
        Environment::Staging.config(),
        Platform::Desktop,
        BuySource::LicenseCard,
    );
    let production = buy_url(
        Environment::Production.config(),
        Platform::Desktop,
        BuySource::LicenseCard,
    );
    assert!(staging.starts_with(STAGING_PAY2_BASE_URL), "{staging}");
    assert!(
        production.starts_with(PRODUCTION_PAY2_BASE_URL),
        "{production}"
    );
    assert!(!staging.contains("//pay2.futo.org"), "{staging}");
}

#[test]
fn the_buy_url_names_its_source_after_the_platform() {
    for (env, host) in [
        (Environment::Production, "https://pay2.futo.org"),
        (Environment::Staging, "https://staging-pay2.futo.org"),
    ] {
        for (source, from) in [
            (BuySource::LicenseCard, "license-card"),
            (BuySource::AppIconPicker, "app-icon"),
        ] {
            assert_eq!(
                buy_url(env.config(), Platform::Ios, source),
                format!(
                    "{host}/checkout/polar/futo-notes/futo-notes-license/checkout-ready?platform=ios&from={from}&success=redirect-to-organization-page"
                )
            );
        }
    }
}

/// The buyer pays in the system browser, so both ends of the flow must be
/// pages a human reads.
#[test]
fn the_buy_url_asks_for_a_page_a_browser_can_render() {
    let url = buy_url(
        Environment::Production.config(),
        Platform::Android,
        BuySource::LicenseCard,
    );
    // `/price` and `/info` on the same path are JSON APIs for the in-app
    // sheets; handing either to the system browser would show a buyer a
    // blob of JSON instead of a checkout.
    assert!(url.contains("/checkout-ready?"), "{url}");
    // `success` must be present or the deployed FUTOpay answers 422, and it
    // must be the storefront's marker: an empty `success` is the
    // client-driven marker, answered with the raw activation JSON, and a
    // buyer who just paid stared at JSON (observed on staging 2026-09-11).
    // This one lands them on the license key page with the Activate link.
    assert!(
        url.contains("success=redirect-to-organization-page"),
        "{url}"
    );
}

#[test]
fn the_two_environments_never_share_a_key_or_a_host() {
    let production = Environment::Production.config();
    let staging = Environment::Staging.config();
    assert_ne!(production.public_key_base64, staging.public_key_base64);
    assert_ne!(production.pay2_base_url, staging.pay2_base_url);
}

#[test]
fn path_separators_cannot_escape_the_activation_segment() {
    let config = LicenseConfig {
        public_key_base64: "",
        pay2_base_url: "https://pay2.example.test",
    };
    assert_eq!(
        activation_url(config, "a/../b c"),
        "https://pay2.example.test/api/v1/activate/a%2F..%2Fb%20c"
    );
}
